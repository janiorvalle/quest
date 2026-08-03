import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupStaleEvidenceMaterializations,
  createEvidenceMaterializer,
  materializedEvidenceFilename,
  sanitizeEvidenceExtension,
} from "./materialize";

describe("evidence materialization", () => {
  test("preserves meaning while enforcing safe filenames and extensions", () => {
    expect(materializedEvidenceFilename("../../sigkill-diagnosis.txt", 1)).toBe(
      "0001-sigkill-diagnosis.txt",
    );
    expect(materializedEvidenceFilename("payload.svg.exe&", 2)).toBe("0002-payload.svg.bin");
    expect(sanitizeEvidenceExtension("C:\\reports\\Proof.JpEg")).toBe(".jpeg");
  });

  test("writes named real files and cleans the materialization directory", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "quest-materialize-root-"));
    try {
      const materializer = await createEvidenceMaterializer(temporaryDirectory);
      const first = await materializer.materialize(
        new TextEncoder().encode("diagnosis"),
        "sigkill-diagnosis.txt",
      );
      const second = await materializer.materialize(
        new TextEncoder().encode("image"),
        "../../Proof.PNG",
      );

      expect(first.filename).toBe("0001-sigkill-diagnosis.txt");
      expect(second.filename).toBe("0002-Proof.png");
      expect(await readFile(first.path, "utf8")).toBe("diagnosis");
      expect(await readFile(second.path, "utf8")).toBe("image");

      await materializer.cleanup();
      await expect(readFile(first.path)).rejects.toThrow();
      await expect(materializer.materialize(new Uint8Array(), "late.txt")).rejects.toThrow(
        "evidence materializer is closed",
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  test("sniffs unknown evidence extensions from content", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "quest-materialize-root-"));
    try {
      const materializer = await createEvidenceMaterializer(temporaryDirectory);
      const fixtures = [
        {
          bytes: new TextEncoder().encode("<!doctype html><html><body>walkthrough</body></html>"),
          filename: "walkthrough",
          expectedExtension: ".html",
        },
        {
          bytes: Uint8Array.from([
            0x1a,
            0x45,
            0xdf,
            0xa3,
            0x87,
            0x42,
            0x82,
            0x84,
            ...new TextEncoder().encode("webm"),
          ]),
          filename: "recording.data",
          expectedExtension: ".webm",
        },
        {
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          filename: "screenshot.blob",
          expectedExtension: ".png",
        },
        {
          bytes: new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBP"),
          filename: "image.blob",
          expectedExtension: ".webp",
        },
        {
          bytes: new TextEncoder().encode('{"status":"passed"}'),
          filename: "result",
          expectedExtension: ".json",
        },
        {
          bytes: new TextEncoder().encode("<!doctype html><html><body>known</body></html>"),
          filename: "walkthrough.txt",
          expectedExtension: ".txt",
        },
        {
          bytes: Uint8Array.from([
            0x1a,
            0x45,
            0xdf,
            0xa3,
            0x8b,
            0x42,
            0x82,
            0x87,
            ...new TextEncoder().encode("matroska"),
          ]),
          filename: "movie.data",
          expectedExtension: ".bin",
        },
        {
          bytes: Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
          filename: "opaque",
          expectedExtension: ".bin",
        },
        {
          bytes: new TextEncoder().encode(`{"payload":"${"x".repeat(64 * 1_024)}"}`),
          filename: "large-result",
          expectedExtension: ".bin",
        },
      ];

      for (const [index, fixture] of fixtures.entries()) {
        const file = await materializer.materialize(fixture.bytes, fixture.filename);
        expect(file.filename).toBe(
          `${String(index + 1).padStart(4, "0")}-${fixture.filename.split(".")[0]}${fixture.expectedExtension}`,
        );
        expect(file.extension).toBe(fixture.expectedExtension);
      }

      await materializer.cleanup();
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  test("removes only owned stale directories", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "quest-materialize-root-"));
    try {
      const materializer = await createEvidenceMaterializer(temporaryDirectory);
      await materializer.materialize(new TextEncoder().encode("diagnosis"), "report.txt");
      const unownedDirectory = join(temporaryDirectory, "quest-evidence-unowned");
      await mkdir(unownedDirectory);

      const removed = await cleanupStaleEvidenceMaterializations(
        temporaryDirectory,
        () => Date.now() + 1,
        0,
      );

      expect(removed).toBe(1);
      await expect(readFile(materializer.directory)).rejects.toThrow();
      expect(await readdir(temporaryDirectory)).toContain("quest-evidence-unowned");
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
