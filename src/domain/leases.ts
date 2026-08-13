import type { Quest } from "../schema";
import { MAX_LEASE_TTL_MINUTES } from "../schema/operations";
import { statusAfterClaimRelease } from "./lifecycle";

export const DEFAULT_LEASE_TTL_MINUTES = 24 * 60;
export const LEASE_TTL_MS = DEFAULT_LEASE_TTL_MINUTES * 60 * 1_000;

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
