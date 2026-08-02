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
  | { readonly status: "published"; readonly quarantined: string | null }
  | { readonly status: "already-published" }
  | { readonly status: "failed"; readonly error: unknown };

// Renaming onto an existing name replaces it atomically on POSIX, but on Windows that is not
// atomic-replace: the filesystem rejects the rename while another publisher still holds the
// destination open. Content addressing makes the collision benign — the destination filename IS
// the sha256 of its bytes, so a rival publisher writing this address wrote byte-identical content
// — which means a failed publication is a real failure only when the destination does not hold
// those bytes.
const PUBLICATION_ATTEMPTS = 3;

// These are the codes a rival publisher can provoke by moving the destination underneath this one:
// a rejected replace while it holds the destination open, or a destination that changed between
// the corruption check and the quarantine link. They are worth another quarantine-then-replace
// cycle; any other error is this publisher's own problem and fails immediately.
function isPublicationRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" ||
      error.code === "EACCES" ||
      error.code === "EBUSY" ||
      error.code === "EEXIST" ||
      error.code === "ENOENT")
  );
}

async function quarantineCorruptDestination(
  destination: string,
  sha256: Sha256,
): Promise<string | null> {
  if (!(await isRegularFile(destination)) || (await matchesContentAddress(destination, sha256))) {
    return null;
  }
  const quarantined = `${destination}.corrupt-${randomUUID()}`;
  await link(destination, quarantined);
  if (await matchesContentAddress(quarantined, sha256)) {
    // Another publisher repaired the destination between the corruption check and the link.
    await removeQuarantinedDestination(quarantined);
    return null;
  }
  return quarantined;
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
    let publication: PublicationResult;
    try {
      await writeTemporaryBlob(temporary, snapshot);
      publication = await this.#publishStagedSnapshotWithRepairs(temporary, destination, sha256);
    } catch (error: unknown) {
      publication = { status: "failed", error };
    }

    // A temporary file left behind by failed cleanup never invalidates a published blob, and a
    // failed publication already carries the more useful error.
    await captureCleanupFailure(() => this.removeTemporaryBlob(temporary));

    switch (publication.status) {
      case "failed":
        throw publication.error;
      case "already-published":
        return { copied: false, quarantined: null };
      default:
        return { copied: true, quarantined: publication.quarantined };
    }
  }

  async #publishStagedSnapshotWithRepairs(
    temporary: string,
    destination: string,
    sha256: Sha256,
  ): Promise<PublicationResult> {
    let race: unknown;
    for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
      try {
        const quarantined = await this.publishStagedSnapshot(temporary, destination, sha256);
        return { status: "published", quarantined };
      } catch (error: unknown) {
        // Whatever the filesystem raised, a destination holding these exact bytes means a rival
        // publisher already wrote them.
        if (await matchesContentAddress(destination, sha256)) {
          return { status: "already-published" };
        }
        if (!isPublicationRace(error)) {
          return { status: "failed", error };
        }
        race = error;
      }
    }
    return { status: "failed", error: race };
  }

  private async publishStagedSnapshot(
    temporary: string,
    destination: string,
    sha256: Sha256,
  ): Promise<string | null> {
    const quarantined = await quarantineCorruptDestination(destination, sha256);
    try {
      await this.publishTemporaryBlob(temporary, destination);
    } catch (error: unknown) {
      await removeQuarantinedDestination(quarantined);
      throw error;
    }
    return quarantined;
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
