import { z } from "zod";
import type { Sha256 } from "../../schema";
import { sha256Schema } from "../../schema";
import type { BlobStore } from "../port";
import {
  authTokenInput,
  type ConvexClientPair,
  closeConvexClientPair,
  convexApi,
  createConvexClientPair,
} from "./client";

export interface ConvexBlobStoreOptions {
  readonly clients?: ConvexClientPair;
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const uploadResponseSchema = z.strictObject({ storageId: z.string().trim().min(1) });

async function contentAddress(bytes: Uint8Array): Promise<Sha256> {
  const digest = await crypto.subtle.digest("SHA-256", copyBytes(bytes));
  const address = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return sha256Schema.parse(address);
}

export class ConvexBlobStore implements BlobStore {
  readonly deployment: string;
  readonly #clients: ConvexClientPair;
  readonly #ownsClients: boolean;
  #failNextPublication = false;

  constructor(deployment: string, options: ConvexBlobStoreOptions = {}) {
    this.deployment = deployment;
    this.#clients = options.clients ?? createConvexClientPair(deployment);
    this.#ownsClients = options.clients === undefined;
  }

  async put(bytes: Uint8Array): Promise<Sha256> {
    return this.#publish(bytes, false);
  }

  async restore(
    sha256: Sha256,
    bytes: Uint8Array,
  ): Promise<{ readonly copied: boolean; readonly quarantined: string | null }> {
    const address = sha256Schema.parse(sha256);
    const snapshot = new Uint8Array(bytes);
    if ((await contentAddress(snapshot)) !== address) {
      throw new Error(`evidence blob ${address} does not match its content address`);
    }
    try {
      if ((await this.get(address)) !== null) {
        return { copied: false, quarantined: null };
      }
    } catch (error: unknown) {
      if (
        !(error instanceof Error && error.message.includes("failed content-address verification"))
      ) {
        throw error;
      }
    }
    await this.#publish(snapshot, true);
    return { copied: true, quarantined: null };
  }

  async #publish(bytes: Uint8Array, replaceExisting: boolean): Promise<Sha256> {
    const snapshot = new Uint8Array(bytes);
    const address = await contentAddress(snapshot);
    if (this.#failNextPublication) {
      this.#failNextPublication = false;
      throw new Error("test blob publication failure requested");
    }
    const uploadUrl = await this.#clients.http.mutation(
      convexApi.generateBlobUploadUrl,
      authTokenInput(this.#clients),
    );
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: copyBytes(snapshot),
    });
    if (!response.ok) {
      throw new Error(
        `Convex blob upload failed with HTTP ${response.status}; retry the publication`,
      );
    }
    const upload = uploadResponseSchema.parse(await response.json());
    return this.#clients.http.action(convexApi.finalizeBlobUpload, {
      ...authTokenInput(this.#clients),
      sha256: address,
      storage_id: upload.storageId,
      replace_existing: replaceExisting,
    });
  }

  async get(sha256: Sha256): Promise<Uint8Array | null> {
    const address = sha256Schema.parse(sha256);
    const url = await this.#clients.http.query(convexApi.getBlobUrl, {
      ...authTokenInput(this.#clients),
      sha256: address,
    });
    if (url === null) {
      return null;
    }
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Convex blob download failed with HTTP ${response.status}; retry the read`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = await contentAddress(bytes);
    if (actual !== address) {
      throw new Error(`Convex blob ${address} failed content-address verification`);
    }
    return bytes;
  }

  async has(sha256: Sha256): Promise<boolean> {
    const address = sha256Schema.parse(sha256);
    return this.#clients.http.query(convexApi.hasBlob, {
      ...authTokenInput(this.#clients),
      sha256: address,
    });
  }

  async failNextPublish(): Promise<void> {
    this.#failNextPublication = true;
  }

  async close(): Promise<void> {
    if (this.#ownsClients) {
      await closeConvexClientPair(this.#clients);
    }
  }
}
