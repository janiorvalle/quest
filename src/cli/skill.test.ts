import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliOutputBoundary, EXIT_SUCCESS } from "../output";
import { createQuestCommand } from "./program";
import {
  executeSkillCli,
  hasQuestSkillInstalled,
  QUEST_SKILL_INSTALL_SUGGESTION,
  refreshInstalledSkillsAfterUpgrade,
  SkillCliConflictError,
  type SkillCliRequest,
} from "./skill";
import { bundledSkillFiles, bundledSkillMarkdown } from "./skill-assets";

async function temporaryHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "quest-skill-"));
}

function runSkill(request: SkillCliRequest, environment: Record<string, string | undefined>) {
  const stdout: string[] = [];
  const output = createCliOutputBoundary({ stdout: (text) => stdout.push(text) });
  return {
    output,
    stdout,
    run: () => executeSkillCli({ environment, format: "human", output, request }),
  };
}

test("installs every bundled asset and is silent when the install is repeated", async () => {
  const home = await temporaryHome();
  try {
    const first = runSkill(
      { command: "skill-install", force: false, stdout: false },
      { HOME: home },
    );
    expect(await first.run()).toBe(EXIT_SUCCESS);
    expect(first.stdout).toEqual([
      ...bundledSkillFiles.map(
        (file) => `Wrote ${join(home, ".claude", "skills", "quest", file.relativePath)}\n`,
      ),
      ...bundledSkillFiles.map(
        (file) => `Wrote ${join(home, ".codex", "skills", "quest", file.relativePath)}\n`,
      ),
    ]);

    for (const directory of [
      join(home, ".claude", "skills", "quest"),
      join(home, ".codex", "skills", "quest"),
    ]) {
      for (const file of bundledSkillFiles) {
        expect(await readFile(join(directory, file.relativePath), "utf8")).toBe(file.content);
      }
    }
    expect(await hasQuestSkillInstalled({ HOME: home })).toBe(true);

    const second = runSkill(
      { command: "skill-install", force: false, stdout: false },
      { HOME: home },
    );
    expect(await second.run()).toBe(EXIT_SUCCESS);
    expect(second.stdout).toEqual([]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("refuses a different version until --force is provided", async () => {
  const home = await temporaryHome();
  const claudeDirectory = join(home, ".claude", "skills", "quest");
  try {
    await mkdir(claudeDirectory, { recursive: true });
    await writeFile(join(claudeDirectory, "SKILL.md"), "different skill\n", "utf8");

    const blocked = runSkill(
      { command: "skill-install", force: false, stdout: false },
      { HOME: home },
    );
    await expect(blocked.run()).rejects.toBeInstanceOf(SkillCliConflictError);
    expect(await readFile(join(claudeDirectory, "SKILL.md"), "utf8")).toBe("different skill\n");
    expect(blocked.stdout).toEqual([]);

    const forced = runSkill(
      { command: "skill-install", force: true, stdout: false },
      { HOME: home },
    );
    expect(await forced.run()).toBe(EXIT_SUCCESS);
    expect(await readFile(join(claudeDirectory, "SKILL.md"), "utf8")).toBe(bundledSkillMarkdown);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("refuses nested symlinks instead of writing outside the skill directory", async () => {
  const home = await temporaryHome();
  const outside = join(home, "outside");
  const claudeDirectory = join(home, ".claude", "skills", "quest");
  try {
    await mkdir(claudeDirectory, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(claudeDirectory, "agents"), "dir");

    const install = runSkill(
      { command: "skill-install", force: true, stdout: false },
      { HOME: home },
    );
    await expect(install.run()).rejects.toBeInstanceOf(SkillCliConflictError);
    expect(await Bun.file(join(outside, "openai.yaml")).exists()).toBe(false);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("uses CODEX_HOME for Codex installation and detection", async () => {
  const home = await temporaryHome();
  const codexHome = join(home, "alternate-codex");
  try {
    const install = runSkill(
      { command: "skill-install", force: false, stdout: false },
      { CODEX_HOME: codexHome, HOME: home },
    );
    expect(await install.run()).toBe(EXIT_SUCCESS);
    expect(await Bun.file(join(codexHome, "skills", "quest", "SKILL.md")).exists()).toBe(true);
    expect(await Bun.file(join(home, ".codex", "skills", "quest", "SKILL.md")).exists()).toBe(
      false,
    );
    expect(await hasQuestSkillInstalled({ CODEX_HOME: codexHome, HOME: home })).toBe(true);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("show and --stdout emit the raw SKILL.md without a wrapper", async () => {
  const show = runSkill({ command: "skill-show" }, {});
  expect(await show.run()).toBe(EXIT_SUCCESS);
  expect(show.stdout).toEqual([bundledSkillMarkdown]);

  const stdout = runSkill({ command: "skill-install", force: false, stdout: true }, {});
  expect(await stdout.run()).toBe(EXIT_SUCCESS);
  expect(stdout.stdout).toEqual([bundledSkillMarkdown]);
});

test("Commander captures skill install options without opening a backend", async () => {
  let captured: unknown;
  const command = createQuestCommand(createCliOutputBoundary(), {
    set: (request) => {
      captured = request;
    },
  });

  await command.parseAsync(
    [
      "skill",
      "install",
      "--force",
      "--claude-dir",
      "/tmp/claude-skill",
      "--codex-dir",
      "/tmp/codex-skill",
    ],
    { from: "user" },
  );

  expect(captured).toEqual({
    claudeDirectory: "/tmp/claude-skill",
    codexDirectory: "/tmp/codex-skill",
    command: "skill-install",
    force: true,
    stdout: false,
  });
});

test("skill detection is unknown when no home directory is available", async () => {
  expect(await hasQuestSkillInstalled({})).toBeUndefined();
  expect(QUEST_SKILL_INSTALL_SUGGESTION).toContain("quest skill install");
});

test("upgrade refreshes only skill homes that were already installed", async () => {
  const home = await temporaryHome();
  const claudeDirectory = join(home, ".claude", "skills", "quest");
  const codexDirectory = join(home, ".codex", "skills", "quest");
  const calls: string[][] = [];
  try {
    for (const directory of [claudeDirectory, codexDirectory]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "stale skill\n", "utf8");
    }
    const result = await refreshInstalledSkillsAfterUpgrade({
      environment: { HOME: home },
      executablePath: "/staged/quest",
      previousVersion: "0.15.0",
      runCommand: async (executable, arguments_) => {
        calls.push([executable, ...arguments_]);
        const directory = arguments_.at(-1);
        if (directory === undefined) {
          throw new Error("missing test directory");
        }
        for (const file of bundledSkillFiles) {
          await mkdir(join(directory, file.relativePath, ".."), { recursive: true });
          await writeFile(join(directory, file.relativePath), file.content, "utf8");
        }
        return { exitCode: 0, stderr: "" };
      },
    });

    expect(result).toEqual({
      failures: [],
      refreshed: [
        { agent: "Claude Code", previous_version: "0.15.0" },
        { agent: "Codex", previous_version: "0.15.0" },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call[0] === "/staged/quest")).toBe(true);
    for (const directory of [claudeDirectory, codexDirectory]) {
      for (const file of bundledSkillFiles) {
        expect(await readFile(join(directory, file.relativePath), "utf8")).toBe(file.content);
      }
    }
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("upgrade leaves absent skill homes untouched", async () => {
  const home = await temporaryHome();
  let commandRuns = 0;
  try {
    const result = await refreshInstalledSkillsAfterUpgrade({
      environment: { HOME: home },
      executablePath: "/staged/quest",
      previousVersion: "0.15.0",
      runCommand: async () => {
        commandRuns += 1;
        return { exitCode: 0, stderr: "" };
      },
    });

    expect(result).toEqual({ failures: [], refreshed: [] });
    expect(commandRuns).toBe(0);
    expect(await Bun.file(join(home, ".claude", "skills", "quest", "SKILL.md")).exists()).toBe(
      false,
    );
    expect(await Bun.file(join(home, ".codex", "skills", "quest", "SKILL.md")).exists()).toBe(
      false,
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("upgrade reports a refresh failure with the manual remedy", async () => {
  const home = await temporaryHome();
  const codexDirectory = join(home, ".codex", "skills", "quest");
  try {
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(join(codexDirectory, "SKILL.md"), "stale skill\n", "utf8");
    const result = await refreshInstalledSkillsAfterUpgrade({
      environment: { HOME: home },
      executablePath: "/staged/quest",
      previousVersion: "0.15.0",
      runCommand: async () => ({ exitCode: 1, stderr: "permission denied" }),
    });

    expect(result).toEqual({
      failures: [
        {
          agent: "Codex",
          message: "permission denied",
          remedy: "quest skill install --force",
        },
      ],
      refreshed: [],
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
