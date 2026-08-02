import { z } from "zod";

import {
  STORE_SCHEMA_VERSION,
  type StoreCompatibilityResult,
  storeCompatibilityResultSchema,
} from "../schema";
import type { StoreCompatibilityProbe } from "./port";

const schemaVersionSchema = z.int().nonnegative();

export type StoreSchemaVersionReader = () => number | null | Promise<number | null>;

export interface StoreCompatibilityProbeOptions {
  readonly migrateStore?: () => Promise<void>;
  readonly readStoreVersion: StoreSchemaVersionReader;
  readonly supportedVersion?: number;
}

function compatibilityResult(
  supportedVersion: number,
  storeVersion: number,
): StoreCompatibilityResult {
  if (storeVersion === supportedVersion) {
    return storeCompatibilityResultSchema.parse({
      outcome: "compatible",
      supported_version: supportedVersion,
      store_version: storeVersion,
    });
  }

  if (storeVersion > supportedVersion) {
    return storeCompatibilityResultSchema.parse({
      outcome: "store-newer",
      supported_version: supportedVersion,
      store_version: storeVersion,
      action: "upgrade-binary",
    });
  }

  return storeCompatibilityResultSchema.parse({
    outcome: "store-older",
    supported_version: supportedVersion,
    store_version: storeVersion,
    action: "migrate-store",
  });
}

export function createStoreCompatibilityProbe(
  options: StoreCompatibilityProbeOptions,
): StoreCompatibilityProbe {
  const supportedVersion = schemaVersionSchema
    .positive()
    .parse(options.supportedVersion ?? STORE_SCHEMA_VERSION);

  return {
    async check() {
      const detectedVersion = await options.readStoreVersion();
      const storeVersion = schemaVersionSchema.parse(detectedVersion ?? supportedVersion);
      return compatibilityResult(supportedVersion, storeVersion);
    },
    ...(options.migrateStore === undefined ? {} : { migrate: options.migrateStore }),
  };
}
