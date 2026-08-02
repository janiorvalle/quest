import { describe, expect, test } from "bun:test";

import { STORE_SCHEMA_VERSION } from "../schema";
import { createStoreCompatibilityProbe } from "./compatibility";

describe("store compatibility probe", () => {
  test("reports a compatible store with both versions", async () => {
    const probe = createStoreCompatibilityProbe({
      readStoreVersion: () => Promise.resolve(STORE_SCHEMA_VERSION),
    });

    await expect(probe.check()).resolves.toEqual({
      outcome: "compatible",
      supported_version: STORE_SCHEMA_VERSION,
      store_version: STORE_SCHEMA_VERSION,
    });
  });

  test("treats a missing store as initializable at the supported version", async () => {
    const probe = createStoreCompatibilityProbe({
      readStoreVersion: () => null,
      supportedVersion: 2,
    });

    await expect(probe.check()).resolves.toEqual({
      outcome: "compatible",
      supported_version: 2,
      store_version: 2,
    });
  });

  test("tells an older binary to upgrade when the store is newer", async () => {
    const probe = createStoreCompatibilityProbe({
      readStoreVersion: () => Promise.resolve(3),
      supportedVersion: 2,
    });

    await expect(probe.check()).resolves.toEqual({
      outcome: "store-newer",
      supported_version: 2,
      store_version: 3,
      action: "upgrade-binary",
    });
  });

  test("tells the caller to migrate when the store is older", async () => {
    const probe = createStoreCompatibilityProbe({
      readStoreVersion: () => Promise.resolve(0),
      supportedVersion: 2,
    });

    await expect(probe.check()).resolves.toEqual({
      outcome: "store-older",
      supported_version: 2,
      store_version: 0,
      action: "migrate-store",
    });
  });

  test("rejects invalid versions from the infrastructure reader", async () => {
    const probe = createStoreCompatibilityProbe({
      readStoreVersion: () => Promise.resolve(-1),
    });

    await expect(probe.check()).rejects.toThrow("Too small");
  });
});
