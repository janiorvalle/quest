import type { Dirent } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MATERIALIZATION_DIRECTORY_PREFIX = "quest-evidence-";
const MATERIALIZATION_OWNER_MARKER = ".quest-evidence-owned";
const MATERIALIZATION_OWNER_VALUE = "quest-evidence/v1\n";
const MATERIALIZATION_TTL_MS = 24 * 60 * 60 * 1_000;
const SAFE_EVIDENCE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".csv",
  ".docx",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".json",
  ".log",
  ".m4a",
  ".md",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".pptx",
  ".tif",
  ".tiff",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xlsx",
]);

export interface MaterializedEvidenceFile {
  readonly extension: string;
  readonly filename: string;
  readonly path: string;
}

export interface StaleEvidenceMaterialization {
  readonly age_seconds: number;
  readonly path: string;
}

export interface EvidenceMaterializer {
  readonly directory: string;
  readonly cleanup: () => Promise<void>;
  readonly materialize: (
    bytes: Uint8Array,
    originalFilename: string,
  ) => Promise<MaterializedEvidenceFile>;
}

function filenameBase(filename: string): string {
  const segments = filename.split(/[\\/]/u);
  return segments.at(-1) ?? "";
}

export function sanitizeEvidenceExtension(filename: string): string {
  const base = filenameBase(filename);
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : "";
  return SAFE_EVIDENCE_EXTENSIONS.has(extension) ? extension : ".bin";
}

function sanitizedStem(filename: string): string {
  const base = filenameBase(filename);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const safe = stem
    .replaceAll(/[^A-Za-z0-9._-]/gu, "_")
    .replaceAll(/_+/gu, "_")
    .replace(/^[_ .]+|[_ .]+$/gu, "")
    .slice(0, 120);
  return safe === "" ? "evidence" : safe;
}

export function materializedEvidenceFilename(filename: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error(`materialization ordinal must be a positive integer: ${ordinal}`);
  }
  return `${String(ordinal).padStart(4, "0")}-${sanitizedStem(filename)}${sanitizeEvidenceExtension(filename)}`;
}

export async function createEvidenceMaterializer(
  temporaryDirectory: string = tmpdir(),
): Promise<EvidenceMaterializer> {
  const directory = await mkdtemp(join(temporaryDirectory, MATERIALIZATION_DIRECTORY_PREFIX));
  try {
    await writeFile(join(directory, MATERIALIZATION_OWNER_MARKER), MATERIALIZATION_OWNER_VALUE, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
  let nextOrdinal = 1;
  let cleaned = false;

  return {
    directory,
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      await rm(directory, { force: true, recursive: true });
      cleaned = true;
    },
    materialize: async (bytes, originalFilename) => {
      if (cleaned) {
        throw new Error("evidence materializer is closed");
      }
      const ordinal = nextOrdinal;
      nextOrdinal += 1;
      const filename = materializedEvidenceFilename(originalFilename, ordinal);
      const path = join(directory, filename);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return {
        extension: sanitizeEvidenceExtension(originalFilename),
        filename,
        path,
      };
    },
  };
}

async function readMaterializationDirectories(temporaryDirectory: string): Promise<Dirent[]> {
  try {
    return await readdir(temporaryDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function staleMaterialization(
  directory: string,
  now: () => number,
  ttlMs: number,
): Promise<StaleEvidenceMaterialization | undefined> {
  try {
    const owner = await readFile(join(directory, MATERIALIZATION_OWNER_MARKER), "utf8");
    const metadata = await stat(directory);
    const ageMs = Math.max(0, now() - metadata.mtimeMs);
    if (owner !== MATERIALIZATION_OWNER_VALUE || ageMs < ttlMs) {
      return undefined;
    }
    return {
      age_seconds: Math.floor(ageMs / 1_000),
      path: directory,
    };
  } catch {
    return undefined;
  }
}

export async function inspectStaleEvidenceMaterializations(
  temporaryDirectory: string = tmpdir(),
  now: () => number = Date.now,
  ttlMs: number = MATERIALIZATION_TTL_MS,
): Promise<readonly StaleEvidenceMaterialization[]> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error(`evidence materialization TTL must be a nonnegative integer: ${ttlMs}`);
  }

  const stale: StaleEvidenceMaterialization[] = [];
  const entries = await readMaterializationDirectories(temporaryDirectory);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MATERIALIZATION_DIRECTORY_PREFIX)) {
      continue;
    }
    const found = await staleMaterialization(join(temporaryDirectory, entry.name), now, ttlMs);
    if (found !== undefined) {
      stale.push(found);
    }
  }
  return stale.sort((left, right) => left.path.localeCompare(right.path));
}

async function removeStaleMaterialization(directory: string): Promise<boolean> {
  try {
    await rm(directory, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function cleanupStaleEvidenceMaterializations(
  temporaryDirectory: string = tmpdir(),
  now: () => number = Date.now,
  ttlMs: number = MATERIALIZATION_TTL_MS,
): Promise<number> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error(`evidence materialization TTL must be a nonnegative integer: ${ttlMs}`);
  }

  let removed = 0;
  const entries = await readMaterializationDirectories(temporaryDirectory);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MATERIALIZATION_DIRECTORY_PREFIX)) {
      continue;
    }

    const stale = await staleMaterialization(join(temporaryDirectory, entry.name), now, ttlMs);
    if (stale !== undefined) {
      if (await removeStaleMaterialization(stale.path)) {
        removed += 1;
      }
    }
  }
  return removed;
}
