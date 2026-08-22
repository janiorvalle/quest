import { describe, expect, test } from "bun:test";

import { newQuestSchema, type Quest, questSchema } from "../../schema";
import type { ConvexRevisionStamp } from "./client";
import {
  ConvexViewerFeed,
  type ViewerFeedPages,
  type ViewerFeedRead,
  type ViewerFeedSubscription,
} from "./viewer-feed";

const timestamp = "2026-08-05T20:00:00.000Z";
const { backfill: _backfill, ...questFields } = newQuestSchema.parse({
  area: "store",
  assignee: null,
  backfill: true,
  description: "Viewer feed fixture",
  guild: null,
  kind: "task",
  opened_by: "test",
  predicted_files: [],
  priority: 2,
  pr: null,
  repo: "quest",
  reopen_count: 0,
  status: "open",
  title: "Viewer feed fixture",
  verdict: null,
  verdict_notes: null,
});

function storedQuest(id: number, overrides: Partial<Quest> = {}): Quest {
  return questSchema.parse({
    ...questFields,
    created_at: timestamp,
    id,
    lease_expires_at: null,
    updated_at: timestamp,
    ...overrides,
  });
}

function pages(quests: readonly Quest[]): ViewerFeedPages {
  return { chains: [], fencedRepositories: [], quests };
}

function stamp(generation: number): ConvexRevisionStamp {
  return { fence_generation: 0, snapshot_generation: generation };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(5);
  }
}

function harness(options: {
  readonly initialQuests?: readonly Quest[];
  readonly leaseCutoff?: string;
  readonly minRefreshIntervalMs?: number;
  readonly read?: () => Promise<ViewerFeedRead>;
}) {
  let onStamp: ((stamp: ConvexRevisionStamp) => void) | undefined;
  let onStampError: ((error: unknown) => void) | undefined;
  let stampUnsubscribed = false;
  let reads = 0;
  let nextQuests: readonly Quest[] = options.initialQuests ?? [];
  const readStarts: number[] = [];
  const feed = new ConvexViewerFeed({
    initialRead: { leaseCutoff: options.leaseCutoff ?? timestamp, pages: pages(nextQuests) },
    initialStamp: stamp(1),
    minRefreshIntervalMs: options.minRefreshIntervalMs ?? 0,
    read:
      options.read ??
      (async () => {
        reads += 1;
        readStarts.push(Date.now());
        return { leaseCutoff: timestamp, pages: pages(nextQuests) };
      }),
    subscribeStamp: (stampListener, errorListener): ViewerFeedSubscription => {
      onStamp = stampListener;
      onStampError = errorListener;
      return {
        unsubscribe: () => {
          stampUnsubscribed = true;
        },
      };
    },
  });
  return {
    feed,
    deliverStamp: (generation: number) => onStamp?.(stamp(generation)),
    failStamp: (error: unknown) => onStampError?.(error),
    reads: () => reads,
    readStarts,
    setQuests: (quests: readonly Quest[]) => {
      nextQuests = quests;
    },
    stampUnsubscribed: () => stampUnsubscribed,
  };
}

describe("ConvexViewerFeed", () => {
  test("delivers the current pages to each new listener and reads once per stamp change", async () => {
    const drill = harness({ initialQuests: [storedQuest(1)] });
    const first: ViewerFeedPages[] = [];
    const second: ViewerFeedPages[] = [];
    drill.feed.subscribe((value) => first.push(value));
    drill.feed.subscribe((value) => second.push(value));

    await waitFor(() => first.length === 1 && second.length === 1);
    expect(first[0]?.quests.map((quest) => quest.id)).toEqual([1]);
    expect(drill.reads()).toBe(0);

    drill.deliverStamp(1);
    await Bun.sleep(10);
    expect(drill.reads()).toBe(0);

    drill.setQuests([storedQuest(1), storedQuest(2)]);
    drill.deliverStamp(2);
    await waitFor(() => first.length === 2 && second.length === 2);
    expect(drill.reads()).toBe(1);
    expect(second[1]?.quests.map((quest) => quest.id)).toEqual([1, 2]);

    drill.feed.close();
    expect(drill.stampUnsubscribed()).toBeTrue();
  });

  test("spaces page reads by the minimum refresh interval", async () => {
    const drill = harness({ minRefreshIntervalMs: 120 });
    const openedAt = Date.now();
    drill.feed.subscribe(() => undefined);

    drill.deliverStamp(2);
    drill.deliverStamp(3);
    await waitFor(() => drill.reads() === 1);
    expect(drill.readStarts[0]).toBeGreaterThanOrEqual(openedAt + 100);
    await Bun.sleep(200);
    expect(drill.reads()).toBe(1);

    drill.deliverStamp(4);
    await waitFor(() => drill.reads() === 2);
    expect((drill.readStarts[1] ?? 0) - (drill.readStarts[0] ?? 0)).toBeGreaterThanOrEqual(100);
    drill.feed.close();
  });

  test("refreshes when the earliest active lease expires", async () => {
    const expiring = storedQuest(1, {
      lease_expires_at: "2026-08-05T20:00:00.050Z",
      status: "accepted",
    });
    const drill = harness({ initialQuests: [expiring], leaseCutoff: timestamp });
    const emissions: ViewerFeedPages[] = [];
    drill.feed.subscribe((value) => emissions.push(value));
    drill.setQuests([storedQuest(1)]);

    await waitFor(() => drill.reads() === 1);
    await waitFor(() => emissions.at(-1)?.quests[0]?.status === "open");
    drill.feed.close();
  });

  test("reports a failed read with the last pages, then retries it", async () => {
    let reads = 0;
    const drill = harness({
      initialQuests: [storedQuest(1)],
      read: async () => {
        reads += 1;
        if (reads === 1) {
          throw new Error("temporary page failure");
        }
        return { leaseCutoff: timestamp, pages: pages([storedQuest(1), storedQuest(2)]) };
      },
    });
    const emissions: Array<{ readonly ids: number[]; readonly error: string | undefined }> = [];
    drill.feed.subscribe((value, error) =>
      emissions.push({ error: error?.message, ids: value.quests.map((quest) => quest.id) }),
    );

    drill.deliverStamp(2);
    await waitFor(() => emissions.some((emission) => emission.error !== undefined));
    expect(emissions.find((emission) => emission.error !== undefined)).toEqual({
      error: "temporary page failure",
      ids: [1],
    });
    await waitFor(() => emissions.at(-1)?.ids.length === 2, 3_000);
    expect(reads).toBe(2);
    drill.feed.close();
  });

  test("passes stamp subscription errors to every listener without a read", async () => {
    const drill = harness({});
    const errors: string[] = [];
    drill.feed.subscribe((_value, error) => {
      if (error !== undefined) {
        errors.push(error.message);
      }
    });

    drill.failStamp(new Error("socket closed"));
    drill.failStamp("not an error");
    expect(errors).toEqual([
      "socket closed",
      "[CONVEX_WATCH_FAILED] the live Convex query stopped responding; check the deployment connection and retry",
    ]);
    expect(drill.reads()).toBe(0);
    drill.feed.close();
  });

  test("ignores stamps and reads after close", async () => {
    const drill = harness({});
    const emissions: ViewerFeedPages[] = [];
    const subscription = drill.feed.subscribe((value) => emissions.push(value));
    subscription.unsubscribe();
    drill.feed.close();

    drill.deliverStamp(2);
    await Bun.sleep(20);
    expect(drill.reads()).toBe(0);
    expect(emissions).toEqual([]);
  });
});
