import { STORE_SCHEMA_VERSION } from "../../schema";
import { createStoreCompatibilityProbe } from "../compatibility";
import type { StoreCompatibilityProbe } from "../port";
import { type ConvexClientPair, convexApi, createConvexHttpClient } from "./client";
import { clientProtocolInput } from "./protocol";

export const CONVEX_OLDER_STORE_REMEDY =
  "deploy the matching Convex functions with `bunx convex deploy`, then retry";

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
    olderStoreRemedy: CONVEX_OLDER_STORE_REMEDY,
    readStoreVersion: () => http.query(convexApi.schemaVersion, clientProtocolInput()),
    supportedVersion: options.supportedVersion ?? STORE_SCHEMA_VERSION,
  });
}
