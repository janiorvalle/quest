import type { Quest, QuestTransition } from "../schema";
import { MAX_LEASE_TTL_MINUTES } from "../schema/operations";
import { statusAfterClaimRelease } from "./lifecycle";

export const DEFAULT_LEASE_TTL_MINUTES = 24 * 60;
export const LEASE_TTL_MS = DEFAULT_LEASE_TTL_MINUTES * 60 * 1_000;

export type LeaseInvalidStateCode =
  | "QUEST_LEASE_EXPIRED"
  | "QUEST_LEASE_HELD"
  | "QUEST_LEASE_REQUIRED"
  | "QUEST_NOT_ACCEPTED";

export class LeaseInvalidStateError extends Error {
  readonly code: LeaseInvalidStateCode;
  readonly receiverMessage: string;

  constructor(code: LeaseInvalidStateCode, receiverMessage: string) {
    super(`[${code}] ${receiverMessage}`);
    this.name = "LeaseInvalidStateError";
    this.code = code;
    this.receiverMessage = receiverMessage;
  }
}

function failLease(code: LeaseInvalidStateCode, message: string): never {
  throw new LeaseInvalidStateError(code, message);
}

export function normalizeLeaseTtlMinutes(value: number | undefined): number {
  const minutes = value ?? DEFAULT_LEASE_TTL_MINUTES;
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > MAX_LEASE_TTL_MINUTES) {
    throw new RangeError(
      `lease TTL must be a positive whole number of minutes no greater than ${MAX_LEASE_TTL_MINUTES}`,
    );
  }
  return minutes;
}

export function leaseExpiry(
  timestamp: string,
  leaseTtlMinutes: number = DEFAULT_LEASE_TTL_MINUTES,
): string {
  const durationMs = normalizeLeaseTtlMinutes(leaseTtlMinutes) * 60 * 1_000;
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}

export function isLeaseExpired(leaseExpiresAt: string | null, now: string): boolean {
  return leaseExpiresAt !== null && Date.parse(leaseExpiresAt) <= Date.parse(now);
}

export function materializeExpiredLease(quest: Quest, now: string): Quest {
  if (quest.status !== "accepted" || !isLeaseExpired(quest.lease_expires_at, now)) {
    return quest;
  }
  return {
    ...quest,
    assignee: null,
    lease_expires_at: null,
    status: statusAfterClaimRelease(),
  };
}

export function transitionRequiresLeaseOwner(
  quest: Pick<Quest, "status">,
  action: QuestTransition["action"],
): boolean {
  if (quest.status !== "accepted") {
    return false;
  }
  switch (action) {
    case "abandon":
    case "cancel":
    case "turnin":
    case "update":
    case "verdict":
      return true;
    case "complete":
    case "reopen":
    case "signoff":
      return false;
  }
}

export function assertLeaseOwner(
  quest: Quest,
  actor: string,
  timestamp: string,
  actorPreviouslyAccepted: boolean,
): void {
  if (quest.status !== "accepted") {
    return;
  }
  if (quest.lease_expires_at === null || isLeaseExpired(quest.lease_expires_at, timestamp)) {
    if (quest.assignee !== actor && actorPreviouslyAccepted) {
      failLease(
        "QUEST_LEASE_EXPIRED",
        `quest ${quest.id} lease expired; stop, ${quest.assignee} has it`,
      );
    }
    failLease("QUEST_LEASE_EXPIRED", `quest ${quest.id} lease expired; re-accept to continue`);
  }
  if (quest.assignee === actor) {
    return;
  }
  if (quest.assignee === null) {
    failLease(
      "QUEST_LEASE_REQUIRED",
      `quest ${quest.id} has no active lease; re-accept to continue`,
    );
  }
  failLease(
    "QUEST_LEASE_HELD",
    `quest ${quest.id} lease owned by ${quest.assignee}; stop, ${quest.assignee} has it`,
  );
}

export function assertActiveLeaseOwner(quest: Quest, owner: string, timestamp: string): void {
  if (quest.status !== "accepted") {
    failLease("QUEST_NOT_ACCEPTED", `quest ${quest.id} is not accepted; re-accept to continue`);
  }
  if (quest.assignee !== owner) {
    if (quest.assignee === null) {
      failLease(
        "QUEST_LEASE_REQUIRED",
        `quest ${quest.id} has no active lease; re-accept to continue`,
      );
    }
    failLease(
      "QUEST_LEASE_HELD",
      `quest ${quest.id} lease owned by ${quest.assignee}; stop, ${quest.assignee} has it`,
    );
  }
  if (quest.lease_expires_at === null || isLeaseExpired(quest.lease_expires_at, timestamp)) {
    failLease("QUEST_LEASE_EXPIRED", `quest ${quest.id} lease expired; re-accept to continue`);
  }
}
