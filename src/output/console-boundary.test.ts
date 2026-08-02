import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Biome rejects console usage outside the output error module", async () => {
  const repositoryRoot = join(import.meta.dir, "../..");
  const fixture = Bun.file(join(import.meta.dir, "fixtures/console-outside.fixture"));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "quest-console-boundary-"));
  const temporarySource = join(temporaryRoot, "console-outside.ts");

  await Bun.write(temporarySource, await fixture.text());
  try {
    const result = Bun.spawnSync({
      cmd: [
        "bunx",
        "biome",
        "lint",
        "--config-path",
        join(repositoryRoot, "biome.json"),
        temporarySource,
        "--only=lint/suspicious/noConsole",
      ],
      cwd: repositoryRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    const diagnostic = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(diagnostic).toContain("lint/suspicious/noConsole");
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
