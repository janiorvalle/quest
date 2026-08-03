import type { Quest } from "../schema";
import { statusAfterClaimRelease } from "./lifecycle";

export const LEASE_TTL_MS = 30 * 60 * 1_000;

export function leaseExpiry(timestamp: string): string {
  return new Date(Date.parse(timestamp) + LEASE_TTL_MS).toISOString();
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
    status: statusAfterClaimRelease(quest),
  };
}
