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
