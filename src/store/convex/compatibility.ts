import { STORE_SCHEMA_VERSION } from "../../schema";
import { createStoreCompatibilityProbe } from "../compatibility";
import type { StoreCompatibilityProbe } from "../port";
import { type ConvexClientPair, convexApi, createConvexHttpClient } from "./client";

export interface ConvexCompatibilityProbeOptions {
  readonly clients?: ConvexClientPair;
  readonly supportedVersion?: number;
}

export function createConvexStoreCompatibilityProbe(
  deployment: string,
  options: ConvexCompatibilityProbeOptions = {},
): StoreCompatibilityProbe {
  const http = options.clients?.http ?? createConvexHttpClient(deployment);
  return createStoreCompatibilityProbe({
    readStoreVersion: () => http.query(convexApi.schemaVersion, {}),
    supportedVersion: options.supportedVersion ?? STORE_SCHEMA_VERSION,
  });
}
