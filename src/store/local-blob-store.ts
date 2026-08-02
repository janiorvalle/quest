import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { type Sha256, sha256Schema } from "../schema";
import type { BlobStore } from "./port";

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

// Windows refuses to link or replace a file that another publisher still holds open and
// reports EPERM, EACCES, or EBUSY instead of waiting. The contention clears as soon as the
// other publisher closes its handle, so concurrent publication stays recoverable there.
const CONTENDED_FILE_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512] as const;

function isContendedFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY")
  );
}

function afterDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryWhileContended(operation: () => Promise<void>): Promise<void> {
  for (const delayMilliseconds of CONTENDED_FILE_RETRY_DELAYS_MS) {
    try {
      await operation();
      return;
    } catch (error: unknown) {
      if (!isContendedFile(error)) {
        throw error;
      }
      await afterDelay(delayMilliseconds);
    }
  }
  await operation();
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function captureCleanupFailure(cleanup: () => Promise<void>): Promise<unknown | undefined> {
  try {
    await cleanup();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

function contentAddress(bytes: Uint8Array): Sha256 {
  return sha256Schema.parse(createHash("sha256").update(bytes).digest("hex"));
}

async function matchesContentAddress(filePath: string, sha256: Sha256): Promise<boolean> {
  try {
    return contentAddress(await readFile(filePath)) === sha256;
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

export interface LocalBlobRestoreResult {
  readonly copied: boolean;
  readonly quarantined: string | null;
}

interface PreparedDestination {
  readonly alreadyPublished: boolean;
}

async function prepareDestination(
  destination: string,
  sha256: Sha256,
): Promise<PreparedDestination> {
  if (!(await isRegularFile(destination))) {
    return { alreadyPublished: false };
  }
  if (await matchesContentAddress(destination, sha256)) {
    return { alreadyPublished: true };
  }
  return { alreadyPublished: false };
}

async function writeTemporaryBlob(temporary: string, snapshot: Uint8Array): Promise<void> {
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(snapshot);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type PublicationResult =
  | { readonly status: "published" }
  | { readonly status: "failed"; readonly error: unknown };

async function publishOrFindExisting(
  destination: string,
  sha256: Sha256,
  publish: () => Promise<void>,
): Promise<PublicationResult> {
  try {
    await publish();
    return { status: "published" };
  } catch (error: unknown) {
    return (await matchesContentAddress(destination, sha256))
      ? { status: "published" }
      : { status: "failed", error };
  }
}

async function removeQuarantinedDestination(quarantined: string | null): Promise<void> {
  if (quarantined === null) {
    return;
  }
  try {
    await unlink(quarantined);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      // Keep the quarantined bytes when cleanup cannot remove them.
    }
  }
}

export class LocalBlobStore implements BlobStore {
  readonly #evidenceDirectory: string;

  constructor(evidenceDirectory: string) {
    if (!isAbsolute(evidenceDirectory)) {
      throw new Error(`evidence directory must be absolute: ${evidenceDirectory}`);
    }
    this.#evidenceDirectory = evidenceDirectory;
  }

  async put(bytes: Uint8Array): Promise<Sha256> {
    const snapshot = Uint8Array.from(bytes);
    const sha256 = contentAddress(snapshot);
    await this.#publishSnapshot(sha256, snapshot);
    return sha256;
  }

  async restore(sha256: Sha256, bytes: Uint8Array): Promise<LocalBlobRestoreResult> {
    const address = sha256Schema.parse(sha256);
    const snapshot = Uint8Array.from(bytes);
    if (contentAddress(snapshot) !== address) {
      throw new Error(`evidence blob ${address} does not match its content address`);
    }
    return this.#publishSnapshot(address, snapshot);
  }

  async #publishSnapshot(sha256: Sha256, snapshot: Uint8Array): Promise<LocalBlobRestoreResult> {
    const destination = join(this.#evidenceDirectory, sha256);
    await mkdir(this.#evidenceDirectory, { recursive: true, mode: 0o700 });

    const prepared = await prepareDestination(destination, sha256);
    if (prepared.alreadyPublished) {
      return { copied: false, quarantined: null };
    }

    const temporary = join(this.#evidenceDirectory, `.${sha256}.${randomUUID()}.tmp`);
    let quarantined: string | null = null;
    let published = false;
    let failure: unknown;
    try {
      await writeTemporaryBlob(temporary, snapshot);
      const publication = await publishOrFindExisting(destination, sha256, async () => {
        await this.publishStagedSnapshot(temporary, destination, sha256, (path) => {
          quarantined = path;
        });
      });
      published = publication.status === "published";
      if (publication.status === "failed") {
        failure = publication.error;
      }
    } catch (error: unknown) {
      failure = error;
    }

    const cleanupFailure = await captureCleanupFailure(() => this.removeTemporaryBlob(temporary));
    if (!published && failure === undefined && cleanupFailure !== undefined) {
      failure = cleanupFailure;
    }

    if (failure !== undefined) {
      await removeQuarantinedDestination(quarantined);
      throw failure;
    }
    return { copied: true, quarantined };
  }

  private async publishStagedSnapshot(
    temporary: string,
    destination: string,
    sha256: Sha256,
    onQuarantine: (path: string | null) => void,
  ): Promise<void> {
    if ((await isRegularFile(destination)) && !(await matchesContentAddress(destination, sha256))) {
      const quarantined = `${destination}.corrupt-${randomUUID()}`;
      await retryWhileContended(() => link(destination, quarantined));
      onQuarantine(quarantined);
      if (await matchesContentAddress(quarantined, sha256)) {
        await removeQuarantinedDestination(quarantined);
        onQuarantine(null);
      }
    }
    await retryWhileContended(() => this.publishTemporaryBlob(temporary, destination));
  }

  protected removeTemporaryBlob(filePath: string): Promise<void> {
    return removeTemporaryFile(filePath);
  }

  async get(sha256: Sha256): Promise<Uint8Array | null> {
    const address = sha256Schema.parse(sha256);
    try {
      return await readFile(join(this.#evidenceDirectory, address));
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  async has(sha256: Sha256): Promise<boolean> {
    const address = sha256Schema.parse(sha256);
    return isRegularFile(join(this.#evidenceDirectory, address));
  }

  protected publishTemporaryBlob(temporary: string, destination: string): Promise<void> {
    return rename(temporary, destination);
  }
}
