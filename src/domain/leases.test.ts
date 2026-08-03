import { describe, expect, test } from "bun:test";

import { MAX_LEASE_TTL_MINUTES } from "../schema";
import { DEFAULT_LEASE_TTL_MINUTES, leaseExpiry, normalizeLeaseTtlMinutes } from "./leases";

describe("lease durations", () => {
  test("uses a 24-hour default", () => {
    expect(DEFAULT_LEASE_TTL_MINUTES).toBe(24 * 60);
    expect(leaseExpiry("2026-08-01T00:00:00Z")).toBe("2026-08-02T00:00:00.000Z");
  });

  test("accepts a positive whole-minute override", () => {
    expect(normalizeLeaseTtlMinutes(45)).toBe(45);
    expect(leaseExpiry("2026-08-01T00:00:00Z", 45)).toBe("2026-08-01T00:45:00.000Z");
  });

  test("rejects invalid durations", () => {
    expect(() => normalizeLeaseTtlMinutes(0)).toThrow(
      "lease TTL must be a positive whole number of minutes",
    );
    expect(() => normalizeLeaseTtlMinutes(1.5)).toThrow(
      "lease TTL must be a positive whole number of minutes",
    );
    expect(() => normalizeLeaseTtlMinutes(MAX_LEASE_TTL_MINUTES + 1)).toThrow(
      "no greater than 100000000",
    );
  });
});
