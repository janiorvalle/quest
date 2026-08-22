import type { Chain, Quest } from "../../schema";
import type { ConvexRevisionStamp } from "./client";

/** Every list page assembled into one backend-consistent read. */
export interface ViewerFeedPages {
  readonly chains: readonly Chain[];
  readonly fencedRepositories: readonly string[];
  readonly quests: readonly Quest[];
}

export interface ViewerFeedRead {
  /** Server clock sampled with the pages; lease expiry is estimated from it. */
  readonly leaseCutoff: string;
  readonly pages: ViewerFeedPages;
}

export type ViewerFeedListener = (pages: ViewerFeedPages, error?: Error) => void;

export interface ViewerFeedSubscription {
  unsubscribe(): void;
}

export interface ConvexViewerFeedOptions {
  readonly initialStamp: ConvexRevisionStamp;
  readonly initialRead: ViewerFeedRead;
  /** Reads the server clock and every list page over HTTP. */
  readonly read: () => Promise<ViewerFeedRead>;
  /** Opens the live subscription on the revision stamp. */
  readonly subscribeStamp: (
    onStamp: (stamp: ConvexRevisionStamp) => void,
    onError: (error: unknown) => void,
  ) => ViewerFeedSubscription;
  readonly minRefreshIntervalMs?: number;
}

/**
 * Agents renew leases several times a second on a busy store. Re-reading every list page for each
 * of those writes costs the same database I/O as the subscription it replaced, so page reads are
 * spaced out; a viewer never lags a write by more than this.
 */
export const VIEWER_REFRESH_MIN_INTERVAL_MS = 1_000;
const VIEWER_REFRESH_RETRY_MS = 1_000;

export function sameRevisionStamp(left: ConvexRevisionStamp, right: ConvexRevisionStamp): boolean {
  return (
    left.snapshot_generation === right.snapshot_generation &&
    left.fence_generation === right.fence_generation
  );
}

export function realtimeWatchError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(
        "[CONVEX_WATCH_FAILED] the live Convex query stopped responding; check the deployment connection and retry",
      );
}

/** Milliseconds until the earliest active lease expires, or null when nothing is leased. */
export function leaseRefreshDelay(
  quests: readonly Quest[],
  leaseCutoff: string,
  boundAt: number,
): number | null {
  const nextExpiry = quests
    .filter((quest) => quest.status === "accepted" && quest.lease_expires_at !== null)
    .map((quest) => Date.parse(quest.lease_expires_at ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const serverAtBind = Date.parse(leaseCutoff);
  if (nextExpiry === undefined || !Number.isFinite(serverAtBind)) {
    return null;
  }
  const estimatedServerNow = serverAtBind + (Date.now() - boundAt);
  return Math.min(Math.max(0, nextExpiry - estimatedServerNow + 1), 2_147_483_647);
}

/**
 * One live view of a Convex deployment's list data shared by every viewer watch on the store.
 *
 * The feed subscribes to the tiny revision stamp, fetches the list pages over HTTP when the stamp
 * changes, and fans the assembled pages out to every listener. Lease expiry refreshes reuse the
 * same fetch path, so a watch still flips an expired claim back to open without a server write.
 */
export class ConvexViewerFeed {
  readonly #options: ConvexViewerFeedOptions;
  readonly #minRefreshIntervalMs: number;
  readonly #listeners = new Set<ViewerFeedListener>();
  readonly #stampSubscription: ViewerFeedSubscription;
  #pages: ViewerFeedPages;
  #leaseCutoff: string;
  #leaseCutoffObservedAt: number;
  #lastStamp: ConvexRevisionStamp;
  #closed = false;
  #refreshRequested = false;
  #refreshInFlight = false;
  #lastRefreshStartedAt: number;
  #retryNotBefore = 0;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #leaseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ConvexViewerFeedOptions) {
    this.#options = options;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ?? VIEWER_REFRESH_MIN_INTERVAL_MS;
    this.#pages = options.initialRead.pages;
    this.#leaseCutoff = options.initialRead.leaseCutoff;
    this.#leaseCutoffObservedAt = Date.now();
    this.#lastRefreshStartedAt = this.#leaseCutoffObservedAt;
    this.#lastStamp = options.initialStamp;
    this.#stampSubscription = options.subscribeStamp(
      (stamp) => this.#receiveStamp(stamp),
      (error) => this.#notify(realtimeWatchError(error)),
    );
    this.#scheduleLeaseRefresh();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Registers a listener; it receives the current pages on the next tick, then every change. */
  subscribe(listener: ViewerFeedListener): ViewerFeedSubscription {
    this.#listeners.add(listener);
    const initialDelivery = setTimeout(() => {
      if (!this.#closed && this.#listeners.has(listener)) {
        listener(this.#pages);
      }
    }, 0);
    initialDelivery.unref?.();
    return {
      unsubscribe: () => {
        clearTimeout(initialDelivery);
        this.#listeners.delete(listener);
      },
    };
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#refreshTimer !== undefined) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    if (this.#leaseTimer !== undefined) {
      clearTimeout(this.#leaseTimer);
      this.#leaseTimer = undefined;
    }
    this.#stampSubscription.unsubscribe();
  }

  #receiveStamp(stamp: ConvexRevisionStamp): void {
    if (this.#closed || sameRevisionStamp(stamp, this.#lastStamp)) {
      return;
    }
    this.#lastStamp = stamp;
    this.#requestRefresh();
  }

  #requestRefresh(): void {
    this.#refreshRequested = true;
    this.#pump();
  }

  #pump(): void {
    if (this.#closed || this.#refreshInFlight || !this.#refreshRequested) {
      return;
    }
    const readyAt = Math.max(
      this.#lastRefreshStartedAt + this.#minRefreshIntervalMs,
      this.#retryNotBefore,
    );
    const wait = readyAt - Date.now();
    if (wait > 0) {
      if (this.#refreshTimer === undefined) {
        this.#refreshTimer = setTimeout(() => {
          this.#refreshTimer = undefined;
          this.#pump();
        }, wait);
        this.#refreshTimer.unref?.();
      }
      return;
    }
    void this.#refresh();
  }

  async #refresh(): Promise<void> {
    this.#refreshRequested = false;
    this.#refreshInFlight = true;
    this.#lastRefreshStartedAt = Date.now();
    try {
      const read = await this.#options.read();
      if (this.#closed) {
        return;
      }
      this.#pages = read.pages;
      this.#leaseCutoff = read.leaseCutoff;
      this.#leaseCutoffObservedAt = Date.now();
      this.#notify();
      this.#scheduleLeaseRefresh();
    } catch (error: unknown) {
      if (this.#closed) {
        return;
      }
      this.#refreshRequested = true;
      this.#retryNotBefore = Date.now() + VIEWER_REFRESH_RETRY_MS;
      this.#notify(realtimeWatchError(error));
    } finally {
      this.#refreshInFlight = false;
      this.#pump();
    }
  }

  #notify(error?: Error): void {
    for (const listener of this.#listeners) {
      listener(this.#pages, error);
    }
  }

  #scheduleLeaseRefresh(): void {
    if (this.#leaseTimer !== undefined) {
      clearTimeout(this.#leaseTimer);
      this.#leaseTimer = undefined;
    }
    const delay = leaseRefreshDelay(
      this.#pages.quests,
      this.#leaseCutoff,
      this.#leaseCutoffObservedAt,
    );
    if (delay === null) {
      return;
    }
    this.#leaseTimer = setTimeout(() => {
      this.#leaseTimer = undefined;
      this.#requestRefresh();
    }, delay);
    this.#leaseTimer.unref?.();
  }
}
