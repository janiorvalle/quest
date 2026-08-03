import type { Dirent } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MATERIALIZATION_DIRECTORY_PREFIX = "quest-evidence-";
const MATERIALIZATION_OWNER_MARKER = ".quest-evidence-owned";
const MATERIALIZATION_OWNER_VALUE = "quest-evidence/v1\n";
const MATERIALIZATION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_EBML_HEADER_BYTES = 4 * 1_024;
const MAX_TEXT_SNIFF_BYTES = 64 * 1_024;
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

function hasBytesAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.byteLength < offset + signature.length) {
    return false;
  }
  return signature.every((value, index) => bytes[offset + index] === value);
}

function hasAsciiAt(bytes: Uint8Array, offset: number, signature: string): boolean {
  if (bytes.byteLength < offset + signature.length) {
    return false;
  }
  return [...signature].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

function ebmlVintWidth(firstByte: number | undefined, maximumWidth: number): number | undefined {
  if (firstByte === undefined) {
    return undefined;
  }
  let marker = 0x80;
  for (let width = 1; width <= maximumWidth; width += 1) {
    if ((firstByte & marker) !== 0) {
      return width;
    }
    marker >>= 1;
  }
  return undefined;
}

function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  maximumWidth: number,
): { readonly value: number; readonly width: number } | undefined {
  const width = ebmlVintWidth(bytes[offset], maximumWidth);
  if (width === undefined || offset + width > bytes.byteLength) {
    return undefined;
  }

  const marker = 0x80 >> (width - 1);
  let value = (bytes[offset] ?? 0) & (marker - 1);
  for (let index = 1; index < width; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) {
      return undefined;
    }
    value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) {
      return undefined;
    }
  }
  return { value, width };
}

function isWebm(bytes: Uint8Array): boolean {
  if (!hasBytesAt(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return false;
  }

  const headerSize = readEbmlVint(bytes, 4, 8);
  if (headerSize === undefined) {
    return false;
  }
  const headerStart = 4 + headerSize.width;
  const headerEnd = headerStart + headerSize.value;
  if (headerEnd > bytes.byteLength || headerEnd > MAX_EBML_HEADER_BYTES) {
    return false;
  }

  let offset = headerStart;
  while (offset < headerEnd) {
    const idWidth = ebmlVintWidth(bytes[offset], 4);
    if (idWidth === undefined) {
      return false;
    }
    const elementSize = readEbmlVint(bytes, offset + idWidth, 8);
    if (elementSize === undefined) {
      return false;
    }
    const valueStart = offset + idWidth + elementSize.width;
    if (valueStart > headerEnd || elementSize.value > headerEnd - valueStart) {
      return false;
    }
    if (idWidth === 2 && hasBytesAt(bytes, offset, [0x42, 0x82]) && elementSize.value === 4) {
      return new TextDecoder().decode(bytes.subarray(valueStart, valueStart + 4)) === "webm";
    }
    offset = valueStart + elementSize.value;
  }
  return false;
}

function sniffEvidenceExtension(bytes: Uint8Array): string | undefined {
  if (hasBytesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ".png";
  }
  if (isWebm(bytes)) {
    return ".webm";
  }
  if (hasAsciiAt(bytes, 0, "RIFF")) {
    if (hasAsciiAt(bytes, 8, "WEBP")) {
      return ".webp";
    }
  }

  const text = new TextDecoder()
    .decode(bytes.subarray(0, MAX_TEXT_SNIFF_BYTES))
    .replace(/^\uFEFF/u, "")
    .trimStart();
  if (/^<!doctype\s+html(?:\s|>|$)/iu.test(text) || /^<html(?:\s|>|$)/iu.test(text)) {
    return ".html";
  }
  if (bytes.byteLength <= MAX_TEXT_SNIFF_BYTES && /^[{[]/u.test(text)) {
    try {
      JSON.parse(text);
      return ".json";
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function evidenceExtension(bytes: Uint8Array, filename: string): string {
  const storedExtension = sanitizeEvidenceExtension(filename);
  return storedExtension === ".bin" ? (sniffEvidenceExtension(bytes) ?? ".bin") : storedExtension;
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

function materializedEvidenceFilenameWithExtension(
  filename: string,
  ordinal: number,
  extension: string,
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error(`materialization ordinal must be a positive integer: ${ordinal}`);
  }
  return `${String(ordinal).padStart(4, "0")}-${sanitizedStem(filename)}${extension}`;
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
      const extension = evidenceExtension(bytes, originalFilename);
      const filename = materializedEvidenceFilenameWithExtension(
        originalFilename,
        ordinal,
        extension,
      );
      const path = join(directory, filename);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return {
        extension,
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
