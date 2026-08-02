import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceMaterializer } from "../evidence";
import type { Evidence } from "../schema";
import { LocalBlobStore } from "../store";
import { materializeQuestEvidence } from "./materialize";

const timestamp = "2026-07-31T00:00:00Z";

function evidence(id: number, sha256: string, filename: string): Evidence {
  return {
    id,
    quest_id: 1,
    sha256,
    filename,
    kind: "log",
    stage: "fix",
    added_by: "fixture",
    created_at: timestamp,
  };
}

test("materializes stored evidence as meaningful named files", async () => {
  const root = await mkdtemp(join(tmpdir(), "quest-service-materialize-"));
  const blobStore = new LocalBlobStore(join(root, "evidence"));
  try {
    const sha256 = await blobStore.put(new TextEncoder().encode("sigkill diagnosis"));
    const result = await materializeQuestEvidence(
      blobStore,
      [evidence(4, sha256, "sigkill-diagnosis.txt")],
      () => createEvidenceMaterializer(root),
    );

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file).toBeDefined();
    if (file === undefined) {
      throw new Error("materialized evidence file is missing");
    }
    expect(file.evidence_id).toBe(4);
    expect(file.filename).toBe("0001-sigkill-diagnosis.txt");
    expect(await readFile(file.path, "utf8")).toBe("sigkill diagnosis");
    await result.cleanup();
    await expect(readFile(file.path)).rejects.toThrow();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("cleans partial materialization when a blob is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "quest-service-materialize-missing-"));
  const blobStore = new LocalBlobStore(join(root, "evidence"));
  let materializerDirectory = "";
  try {
    await expect(
      materializeQuestEvidence(
        blobStore,
        [evidence(8, "a".repeat(64), "missing.log")],
        async () => {
          const materializer = await createEvidenceMaterializer(root);
          materializerDirectory = materializer.directory;
          return materializer;
        },
      ),
    ).rejects.toThrow("evidence 8 (missing.log) is missing blob");
    await expect(readFile(materializerDirectory)).rejects.toThrow();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
