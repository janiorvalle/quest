import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { loadConfig } from "../src/config";
import { createPlatform } from "../src/platform";
import type { Config, Quest } from "../src/schema";
import {
  type CommandResult,
  type CommandSpec,
  confirmDispatchTrust,
  createWorkerInvocation,
  type DispatchOptions,
  type DispatchRuntime,
  dispatch,
  hasCodexSubscriptionLogin,
  parseCodexAuthConfig,
  parseDispatchArguments,
  questNetworkDomains,
  requireGuardedClaudeCompatibility,
  requireGuardedCodexCompatibility,
  requireQuestCliCompatibility,
  resolveDispatchOptions,
  type WorkerHandle,
} from "./dispatch";

const defaultDispatchConfig = {
  claude_args: [],
  codex_args: [],
  trust: "full",
} satisfies NonNullable<Config["dispatch"]>;

function dispatchOptions(argumentsWithoutTrust: readonly string[] = []): DispatchOptions {
  return resolveDispatchOptions(
    parseDispatchArguments(["--trust", "full", ...argumentsWithoutTrust]),
    defaultDispatchConfig,
  );
}

function trustOptions(trust: "full" | "guarded", yes = false): DispatchOptions {
  return resolveDispatchOptions(
    parseDispatchArguments(["--trust", trust, ...(yes ? ["--yes"] : [])]),
    defaultDispatchConfig,
  );
}

// The dispatcher builds worker paths with the host's rules, so expectations have to be
// built the same way: a literal POSIX string only describes the arguments on a POSIX host.
// Guarded Claude encodes a directory as //<resolved path, forward slashes>/**.
function permissionGlob(path: string): string {
  return `//${resolve(path).replaceAll("\\", "/").replace(/^\/+/u, "")}/**`;
}

// Guarded Codex encodes a directory as a TOML string, which escapes Windows backslashes.
function tomlPathLiteral(path: string): string {
  return JSON.stringify(resolve(path));
}

// Reading the sandbox allowlist back out of the settings argument compares real paths
// instead of searching a JSON blob for a substring that Windows escapes differently.
function claudeSandboxReadPaths(invocation: {
  readonly args: readonly string[];
}): readonly string[] {
  const settings = invocation.args[invocation.args.indexOf("--settings") + 1];
  if (settings === undefined) {
    throw new Error("guarded Claude invocation did not include native sandbox settings");
  }
  const parsed = JSON.parse(settings) as {
    sandbox: { filesystem: { allowRead: readonly string[] } };
  };
  return parsed.sandbox.filesystem.allowRead;
}

function quest(id: number, title: string): Quest {
  return {
    area: "agents",
    assignee: `quest-dispatch/9/${id}`,
    created_at: "2026-07-31T05:00:00Z",
    description: `Implement ${title}`,
    guild: null,
    id,
    kind: "task",
    lease_expires_at: "2026-07-31T06:00:00Z",
    opened_by: "janiorvalle",
    predicted_files: [`src/${id}.ts`],
    priority: 2,
    pr: null,
    reopen_count: 0,
    repo: "quest",
    status: "accepted",
    title,
    updated_at: "2026-07-31T05:00:00Z",
    verdict: null,
    verdict_notes: null,
  };
}

function briefFor(item: Quest) {
  return {
    chain_position: { duplicate_of: [], duplicates: [], required_by: [], requires: [] },
    evidence: [],
    events: [],
    materialized: null,
    quest: item,
  };
}

function nextReport(item: Quest | null): string {
  return JSON.stringify({
    command: "next",
    data: { brief: item === null ? null : briefFor(item), claimed: item !== null, quest: item },
    filters: { repo: "quest" },
    generated_at: "2026-07-31T05:00:00Z",
    schema: "quest.report/v1",
    warnings: [],
  });
}

function touchReport(item: Quest): string {
  return JSON.stringify({
    command: "touch",
    data: { changed: true, evidence: [], quest: item },
    filters: { repo: "quest" },
    generated_at: "2026-07-31T05:00:00Z",
    schema: "quest.report/v1",
    warnings: [],
  });
}

function showReport(item: Quest, status: Quest["status"] = "turned_in"): string {
  return JSON.stringify({
    command: "show",
    data: { quest: { ...item, status } },
    filters: { id: item.id, repo: "quest" },
    generated_at: "2026-07-31T05:00:00Z",
    schema: "quest.report/v1",
    warnings: [],
  });
}

function workerHandle(completion: Promise<number>): WorkerHandle {
  return {
    completion,
    async cancel() {},
  };
}

function gitMetadataResult(spec: CommandSpec): CommandResult | null {
  return spec.args.includes("--git-dir")
    ? {
        exitCode: 0,
        stderr: "",
        stdout: `${join(spec.cwd, ".git-worktree")}\n${join(spec.cwd, "..", ".git-common")}\n`,
      }
    : null;
}

function fakeCommandResponse(
  spec: CommandSpec,
  handlers: ReadonlyArray<readonly [string, () => CommandResult]>,
): CommandResult {
  const metadata = gitMetadataResult(spec);
  if (spec.args.includes("symbolic-ref")) {
    return { exitCode: 0, stderr: "", stdout: `quest/${basename(spec.cwd)}\n` };
  }
  const handler = handlers.find(([argument]) => spec.args.includes(argument));
  return spec.args.includes("--verify")
    ? { exitCode: 0, stderr: "", stdout: "HEAD\n" }
    : spec.args.includes("rev-parse") && spec.args.includes("HEAD")
      ? { exitCode: 0, stderr: "", stdout: "0123456789012345678901234567890123456789\n" }
      : (metadata ?? handler?.[1]() ?? { exitCode: 0, stderr: "", stdout: "" });
}

async function prepareFakeWorktree(spec: CommandSpec): Promise<void> {
  if (!spec.args.includes("worktree") || !spec.args.includes("add")) {
    return;
  }
  const addFlag = spec.args.indexOf("add");
  const worktreePath = spec.args[addFlag + 1];
  if (worktreePath === undefined) {
    return;
  }
  await mkdir(worktreePath, { recursive: true });
  await writeFile(join(worktreePath, ".git"), "gitdir: fake/.git-worktree\n");
}

// The dispatcher seeds the worker config where the worker's own Quest will look for it,
// which is APPDATA on Windows rather than XDG_CONFIG_HOME. Ask the platform module the
// same question the worker would ask instead of assuming the POSIX location.
function workerQuestConfigFile(spec: CommandSpec): string | null {
  const configHome = spec.env?.["XDG_CONFIG_HOME"];
  if (configHome === undefined) {
    return null;
  }
  const workerPlatform = createPlatform({
    environment: spec.env ?? {},
    homeDirectory: dirname(configHome),
  });
  return join(workerPlatform.directories.config, "config.toml");
}

// Concurrency is proven by an overlap that has to happen, not by a sleep long enough for a
// fast host to win the race: every worker parks here until the expected number have started,
// so a dispatcher that serialized them fails with a named error instead of a quiet pass.
function workerStartBarrier(expectedWorkers: number): () => Promise<void> {
  let release: () => void = () => {};
  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  let startedWorkers = 0;
  return async () => {
    startedWorkers += 1;
    if (startedWorkers >= expectedWorkers) {
      release();
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        allStarted,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `the dispatcher ran ${startedWorkers} of ${expectedWorkers} workers at once`,
                ),
              ),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function workerArtifacts(spec: CommandSpec): Promise<{
  readonly brief: string;
  readonly questConfig: string;
}> {
  const prompt = spec.args.find((argument) => argument.includes("read it from "));
  const briefPath = prompt?.match(/read it from (.+?) instead/u)?.[1];
  const brief =
    briefPath === undefined
      ? ""
      : await readFile(isAbsolute(briefPath) ? briefPath : join(spec.cwd, briefPath), "utf8");
  const questConfigFile = workerQuestConfigFile(spec);
  const questConfig = questConfigFile === null ? "" : await readFile(questConfigFile, "utf8");
  return { brief, questConfig };
}

async function loadWorkerQuestConfig(spec: CommandSpec): Promise<Config | null> {
  const configFile = workerQuestConfigFile(spec);
  if (configFile === null) {
    return null;
  }
  return loadConfig({
    configFile,
    environment: {},
    platform: createPlatform({ environment: {}, homeDirectory: spec.cwd }),
  });
}

interface PartialWorktreeState {
  added: boolean;
  claimed: boolean;
  path: string;
  branch: string;
}

async function partialWorktreeCommand(
  spec: CommandSpec,
  state: PartialWorktreeState,
): Promise<CommandResult> {
  if (spec.args.includes("show-ref")) {
    return state.added
      ? { exitCode: 0, stderr: "", stdout: "" }
      : { exitCode: 1, stderr: "", stdout: "" };
  }
  if (spec.args.includes("worktree") && spec.args.includes("list")) {
    return {
      exitCode: 0,
      stderr: "",
      stdout: state.added
        ? `worktree ${state.path}\nHEAD HEAD\nbranch refs/heads/${state.branch}\n`
        : "",
    };
  }
  if (spec.args.includes("worktree") && spec.args.includes("add")) {
    const addFlag = spec.args.indexOf("add");
    state.path = spec.args[addFlag + 1] ?? "";
    state.branch = spec.args[addFlag + 2] ?? "";
    state.added = true;
    await prepareFakeWorktree(spec);
    return { exitCode: 1, stderr: "worktree partially created", stdout: "" };
  }
  return fakeCommandResponse(spec, [
    [
      "next",
      () => {
        const item = state.claimed ? null : quest(7, "Partial worktree");
        state.claimed = true;
        return { exitCode: 0, stderr: "", stdout: nextReport(item) };
      },
    ],
  ]);
}

function realCommandEnvironment(spec: CommandSpec): Record<string, string> {
  const inheritedNames = new Set(["LANG", "LC_ALL", "PATH", "PATHEXT", "SYSTEMROOT", "TERM"]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => inheritedNames.has(entry[0]) && entry[1] !== undefined,
    ),
  );
  const isolatedHome = spec.env?.["HOME"] ?? join(spec.cwd, ".quest-real-git-home");
  const disabledConfigPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return Object.fromEntries(
    Object.entries({
      ...inherited,
      HOME: isolatedHome,
      GIT_CONFIG_GLOBAL: disabledConfigPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: disabledConfigPath,
      ...spec.env,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function runRealCommand(spec: CommandSpec): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [spec.command, ...spec.args],
    cwd: spec.cwd,
    env: realCommandEnvironment(spec),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function runSuccessfulRealCommand(spec: CommandSpec): Promise<CommandResult> {
  const result = await runRealCommand(spec);
  if (result.exitCode !== 0) {
    throw new Error(
      `${spec.command} ${spec.args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

function workerGitCommand(spec: CommandSpec, args: readonly string[]): CommandSpec {
  return {
    args,
    command: "git",
    cwd: spec.cwd,
    ...(spec.env === undefined ? {} : { env: spec.env }),
  };
}

interface RealDispatchState {
  claimed: boolean;
}

function realDispatchResponse(
  spec: CommandSpec,
  workerQuest: Quest,
  state: RealDispatchState,
): CommandResult | null {
  if (spec.command === "python3") {
    return { exitCode: 0, stderr: "", stdout: "" };
  }
  if (spec.command !== "quest") {
    return null;
  }
  if (spec.args.includes("next")) {
    const item = state.claimed ? null : workerQuest;
    state.claimed = true;
    return { exitCode: 0, stderr: "", stdout: nextReport(item) };
  }
  if (spec.args.includes("show")) {
    return { exitCode: 0, stderr: "", stdout: showReport(workerQuest) };
  }
  return { exitCode: 0, stderr: "", stdout: "" };
}

async function runRealDispatchCommand(
  spec: CommandSpec,
  workerQuest: Quest,
  state: RealDispatchState,
): Promise<CommandResult> {
  if (spec.command === "git") {
    return runRealCommand(spec);
  }
  const response = realDispatchResponse(spec, workerQuest, state);
  if (response !== null) {
    return response;
  }
  throw new Error(`unexpected command in real Git test: ${spec.command}`);
}

describe("dispatcher", () => {
  test("parses conservative defaults and tunable worker settings", () => {
    expect(parseDispatchArguments(["--agent", "claude", "--concurrency", "3"])).toEqual({
      agent: "claude",
      baseRef: "HEAD",
      concurrency: 3,
      skipAfterReopens: 2,
      trust: undefined,
      yes: false,
    });
  });

  test("requires trust explicitly unless config pins a personal default", () => {
    expect(parseDispatchArguments(["--trust", "guarded", "--yes"]).trust).toBe("guarded");
    expect(() => resolveDispatchOptions(parseDispatchArguments([]))).toThrow(
      "DISPATCH_TRUST_REQUIRED",
    );
    expect(
      resolveDispatchOptions(parseDispatchArguments([]), {
        claude_args: ["--model", "sonnet"],
        codex_args: ["--model", "gpt-5"],
        trust: "guarded",
      }),
    ).toMatchObject({
      claudeArgs: ["--model", "sonnet"],
      codexArgs: ["--model", "gpt-5"],
      trust: "guarded",
    });
    expect(() =>
      resolveDispatchOptions(parseDispatchArguments([]), {
        claude_args: ["--settings", "{}"],
        codex_args: [],
        trust: "guarded",
      }),
    ).toThrow("DISPATCH_TRUST_ARGUMENT_CONFLICT");
    expect(() =>
      resolveDispatchOptions(parseDispatchArguments([]), {
        claude_args: [],
        codex_args: ["--sandbox", "danger-full-access"],
        trust: "guarded",
      }),
    ).toThrow("DISPATCH_TRUST_ARGUMENT_CONFLICT");
    for (const claudeArgument of [
      "--agent",
      "--append-system-prompt-file",
      "--bg",
      "--mcp-config",
      "--mcp-config=project.json",
      "--chrome",
      "--cloud",
      "--continue",
      "--debug-file",
      "--exec",
      "--file",
      "--from-pr",
      "--fork-session",
      "--ide",
      "--name",
      "--plugin-dir",
      "--remote-control",
      "--remote",
      "--resume",
      "--session-id",
      "--system-prompt-file",
      "--tmux",
      "--teleport",
      "--worktree",
      "-c",
      "-d",
      "-n",
      "-p",
      "-r",
      "-w",
      "--",
    ]) {
      expect(() =>
        resolveDispatchOptions(parseDispatchArguments([]), {
          claude_args: [claudeArgument],
          codex_args: [],
          trust: "guarded",
        }),
      ).toThrow("DISPATCH_TRUST_ARGUMENT_CONFLICT");
    }
    for (const codexArgument of [
      "-sdanger-full-access",
      "-anever",
      "-ckey=value",
      "-i/host/secret.png",
      "-o/host/output.txt",
      "--dangerously-bypass-hook-trust",
      "--ignore-rules",
      "--output-last-message=/host/output.txt",
      "--output-schema=/host/schema.json",
      "--search",
      "--",
    ]) {
      expect(() =>
        resolveDispatchOptions(parseDispatchArguments([]), {
          claude_args: [],
          codex_args: [codexArgument],
          trust: "guarded",
        }),
      ).toThrow("DISPATCH_TRUST_ARGUMENT_CONFLICT");
    }
  });

  test("accepts only the Codex ChatGPT subscription login status", () => {
    expect(
      hasCodexSubscriptionLogin({
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
    ).toBeFalse();
    expect(
      hasCodexSubscriptionLogin({
        exitCode: 0,
        stderr: "Logged in using ChatGPT\n",
        stdout: "",
      }),
    ).toBeTrue();
    expect(
      hasCodexSubscriptionLogin({
        exitCode: 0,
        stderr: "",
        stdout: "Logged in using API key\n",
      }),
    ).toBeFalse();
    expect(
      hasCodexSubscriptionLogin({
        exitCode: 1,
        stderr: "not logged in",
        stdout: "",
      }),
    ).toBeFalse();
  });

  test("preserves Codex subscription auth and resolves worker attribution settings", () => {
    expect(
      parseCodexAuthConfig(`
forced_chatgpt_workspace_id = ["workspace-a", "workspace-b"]
forced_login_method = "chatgpt"
cli_auth_credentials_store = "keyring"
chatgpt_base_url = "https://chatgpt.example.test/backend-api/"
model = "untrusted-model-setting"
`),
    ).toEqual({
      chatgptBaseUrl: "https://chatgpt.example.test/backend-api/",
      cliAuthCredentialsStore: "keyring",
      forcedChatgptWorkspaceId: ["workspace-a", "workspace-b"],
      forcedLoginMethod: "chatgpt",
      model: "untrusted-model-setting",
    });

    const invocation = createWorkerInvocation({
      agent: "codex",
      codexAuthConfig: {
        chatgptBaseUrl: "https://chatgpt.example.test/backend-api/",
        cliAuthCredentialsStore: "keyring",
        forcedChatgptWorkspaceId: ["workspace-a", "workspace-b"],
        forcedLoginMethod: "chatgpt",
      },
      hostHomePath: "/Users/subscription-user",
      trust: "guarded",
      workerHomePath: "/tmp/quest-worker-home",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });

    expect(invocation.args).toContain('forced_chatgpt_workspace_id=["workspace-a","workspace-b"]');
    expect(invocation.args).toContain('forced_login_method="chatgpt"');
    expect(invocation.args).toContain('cli_auth_credentials_store="keyring"');
    expect(invocation.args).toContain(
      'chatgpt_base_url="https://chatgpt.example.test/backend-api/"',
    );
    expect(invocation.args).not.toContain('model="untrusted-model-setting"');
    expect(
      parseCodexAuthConfig(`
profile = "corp"
model = "gpt-5-default"
model_reasoning_effort = "medium"
chatgpt_base_url = "https://chatgpt.example.test/default/"
[profiles.corp]
model = "gpt-5-corp"
model_reasoning_effort = "high"
chatgpt_base_url = "https://chatgpt.example.test/corp/"
`),
    ).toEqual({
      chatgptBaseUrl: "https://chatgpt.example.test/corp/",
      model: "gpt-5-corp",
      profile: "corp",
      profiles: {
        corp: {
          model: "gpt-5-corp",
          reasoningEffort: "high",
        },
      },
      reasoningEffort: "high",
    });
  });

  test("stamps only authoritative Codex CLI attribution", () => {
    const codexAuthConfig = parseCodexAuthConfig(`
model = "gpt-5-default"
model_reasoning_effort = "medium"
[profiles.fast]
model = "gpt-5-fast"
model_reasoning_effort = "high"
[profiles.slow]
model = "gpt-5-slow"
`);
    const invocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: [
        "--profile",
        "fast",
        "--model",
        "gpt-5-explicit",
        "-c",
        'model="gpt-5-config"',
        "--reasoning-effort",
        "low",
        '--config=model_reasoning_effort="max"',
      ],
      codexAuthConfig,
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });

    expect(invocation.env).toMatchObject({
      QUEST_EFFORT: "low",
      QUEST_MODEL: "gpt-5-explicit",
    });

    const configInvocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: [
        "-c",
        'model="gpt-5-config"',
        '--config=model_reasoning_effort="max"',
        "--profile",
        "fast",
      ],
      codexAuthConfig,
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(configInvocation.env).toMatchObject({
      QUEST_EFFORT: "max",
      QUEST_MODEL: "gpt-5-config",
    });

    const profileConfigInvocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: [
        "--profile",
        "fast",
        "-c",
        'profiles.fast.model="gpt-5-profile-config"',
        '--config=profiles.fast.model_reasoning_effort="xhigh"',
      ],
      codexAuthConfig,
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(profileConfigInvocation.env).toMatchObject({
      QUEST_EFFORT: "xhigh",
      QUEST_MODEL: "gpt-5-profile-config",
    });

    const configProfileSelectionInvocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: [
        "-c",
        'profiles.fast.model="gpt-5-profile-config"',
        "-c",
        'profiles.fast.model_reasoning_effort="xhigh"',
        "-c",
        'profile="fast"',
      ],
      codexAuthConfig,
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(configProfileSelectionInvocation.env).toMatchObject({
      QUEST_EFFORT: "xhigh",
      QUEST_MODEL: "gpt-5-profile-config",
    });

    const attachedConfigInvocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: ['-cmodel="gpt-5-attached"', '-cmodel_reasoning_effort="xhigh"'],
      codexAuthConfig,
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(attachedConfigInvocation.env).toMatchObject({
      QUEST_EFFORT: "xhigh",
      QUEST_MODEL: "gpt-5-attached",
    });

    const profileInvocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: ["-p", "slow"],
      codexAuthConfig,
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(profileInvocation.env?.["QUEST_EFFORT"]).toBeUndefined();
    expect(profileInvocation.env?.["QUEST_MODEL"]).toBeUndefined();

    const profileFileInvocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: ["--profile", "fast"],
      codexAuthConfig: {
        ...codexAuthConfig,
        profileFiles: {
          fast: { model: "gpt-5-file" },
        },
      },
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(profileFileInvocation.env?.["QUEST_EFFORT"]).toBeUndefined();
    expect(profileFileInvocation.env?.["QUEST_MODEL"]).toBeUndefined();

    const explicitProfileWinsInvocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: ["--profile", "slow", "-c", 'profile="fast"'],
      codexAuthConfig,
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(explicitProfileWinsInvocation.env?.["QUEST_EFFORT"]).toBeUndefined();
    expect(explicitProfileWinsInvocation.env?.["QUEST_MODEL"]).toBeUndefined();
  });

  test("ignores attribution-looking arguments after the end marker", () => {
    const invocation = createWorkerInvocation({
      agent: "codex",
      codexArgs: ["--", "--model=fake", "--effort", "fake"],
      codexAuthConfig: {
        model: "gpt-5-config",
        reasoningEffort: "medium",
      },
      hostHomePath: "/Users/subscription-user",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-without-project-config",
    });

    expect(invocation.env?.["QUEST_EFFORT"]).toBeUndefined();
    expect(invocation.env?.["QUEST_MODEL"]).toBeUndefined();
  });

  test("keeps supported Convex identifiers in full trust and scopes guarded URLs", () => {
    expect(
      questNetworkDomains({ backend: "convex", convex_deployment: "dev:quest" }, "full"),
    ).toEqual([]);
    expect(
      questNetworkDomains(
        { backend: "convex", deployment: "https://quest.example.test/deployment" },
        "guarded",
      ),
    ).toEqual(["quest.example.test"]);
    expect(() =>
      questNetworkDomains({ backend: "convex", convex_deployment: "dev:quest" }, "guarded"),
    ).toThrow("DISPATCH_QUEST_BACKEND_INVALID");
  });

  test("uses native full and guarded trust modes for both worker CLIs", () => {
    const workerQuest = quest(42, "Make the queue sing");
    const hostHomePath = "/Users/subscription-user";
    const workerHomePath = "/tmp/quest-worker-home";
    const fullClaude = createWorkerInvocation({
      agent: "claude",
      claudeArgs: ["--model", "sonnet", "--effort", "high"],
      guild: "codex",
      hostHomePath,
      trust: "full",
      workerCliPath: "/opt/bin/claude",
      workerHomePath,
      owner: "quest-dispatch/9/1",
      quest: workerQuest,
      worktreePath: "/tmp/quest-42",
    });
    const explicitClaude = createWorkerInvocation({
      agent: "claude",
      hostClaudeConfigPath: "/Users/subscription-user/.claude-work",
      hostHomePath,
      trust: "full",
      workerHomePath,
      owner: "quest-dispatch/9/1",
      quest: workerQuest,
      worktreePath: "/tmp/quest-42",
    });
    const guardedClaude = createWorkerInvocation({
      agent: "claude",
      guild: "codex",
      gitReadableRoots: ["/tmp/read-only-git"],
      gitWritableRoots: ["/tmp/writable-git"],
      hostHomePath,
      questBackendDomains: ["quest.example.test"],
      questRepositoryName: "quest",
      trust: "guarded",
      workerCliPath: "/opt/bin/claude",
      workerHomePath,
      workerSupportPaths: [`${hostHomePath}/.codex/bin/node`],
      owner: "quest-dispatch/9/1",
      quest: workerQuest,
      worktreePath: "/tmp/quest-42",
    });
    const fullCodex = createWorkerInvocation({
      agent: "codex",
      codexArgs: ["--model", "gpt-5"],
      briefPath: "./.quest-dispatch-brief-42-test.json",
      gitWritableRoots: ["/tmp/worktree-git", "/tmp/repo-git"],
      hostHomePath,
      trust: "full",
      workerCliPath: "/opt/bin/codex",
      workerHomePath,
      owner: "quest-dispatch/9/1",
      quest: workerQuest,
      worktreePath: "/tmp/quest-42",
    });
    const explicitCodex = createWorkerInvocation({
      agent: "codex",
      hostCodexHomeOverridePath: "/Users/subscription-user/.codex-work",
      hostHomePath,
      trust: "full",
      workerCliPath: "/opt/bin/codex",
      workerHomePath,
      owner: "quest-dispatch/9/1",
      quest: workerQuest,
      worktreePath: "/tmp/quest-42",
    });
    const guardedCodex = createWorkerInvocation({
      agent: "codex",
      codexAuthConfig: { model: "host-config-model", reasoningEffort: "host-config-effort" },
      gitWritableRoots: ["/tmp/worktree-git", "/tmp/repo-git"],
      hostHomePath,
      questBackendDomains: ["quest.example.test"],
      questRepositoryName: "quest",
      trust: "guarded",
      workerCliPath: "/opt/bin/codex",
      workerHomePath,
      owner: "quest-dispatch/9/1",
      quest: workerQuest,
      worktreePath: "/tmp/quest-42",
    });
    const reopened = createWorkerInvocation({
      agent: "codex",
      branchSuffix: "-attempt-2",
      trust: "full",
      owner: "quest-dispatch/9/1",
      quest: workerQuest,
      worktreePath: "/tmp/quest-42-attempt-2",
    });

    expect(fullClaude.command).toBe("/opt/bin/claude");
    expect(fullClaude.args).toContain("quest 42 — make-the-queue-sing");
    expect(fullClaude.args).toContain("--dangerously-skip-permissions");
    expect(fullClaude.args).not.toContain("--allowed-tools");
    expect(fullClaude.args).not.toContain("sandbox-exec");
    expect(fullClaude.args).toContain("--model");
    expect(fullClaude.env).toMatchObject({
      GH_CONFIG_DIR: join(workerHomePath, ".config", "gh"),
      GIT_CONFIG_GLOBAL: join(workerHomePath, ".gitconfig"),
      HOME: hostHomePath,
      BUN_INSTALL_CACHE_DIR: join(workerHomePath, ".bun", "install", "cache"),
      QUEST_GUILD: "codex",
      QUEST_EFFORT: "high",
      QUEST_IDENTITY: "quest-dispatch/9/1",
      QUEST_MODEL: "sonnet",
    });
    expect(fullClaude.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(explicitClaude.env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/Users/subscription-user/.claude-work",
    });
    expect(guardedClaude.args).toContain("--permission-mode");
    expect(guardedClaude.args).toContain("dontAsk");
    expect(guardedClaude.args).toContain("--allowed-tools");
    expect(guardedClaude.args).toContain("--setting-sources");
    expect(guardedClaude.args).toContain("");
    expect(guardedClaude.args).toContain("--safe-mode");
    expect(
      guardedClaude.args.some((argument) => argument.includes("quest.example.test")),
    ).toBeTrue();
    expect(guardedClaude.env?.["QUEST_REPOS"]).toBe('{"quest-42":"quest"}');
    expect(guardedClaude.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(guardedClaude.args).toContain("--add-dir");
    expect(guardedClaude.args).toContain("/tmp/quest-42");
    expect(guardedClaude.args).toContain("/tmp/read-only-git");
    expect(guardedClaude.args).toContain("--settings");
    expect(guardedClaude.args.some((argument) => argument.includes('"enabled":true'))).toBeTrue();
    expect(
      guardedClaude.args.some((argument) => argument.includes('"failIfUnavailable":true')),
    ).toBeTrue();
    expect(
      guardedClaude.args.some((argument) => argument.includes('"allowUnsandboxedCommands":false')),
    ).toBeTrue();
    expect(
      guardedClaude.args.some((argument) =>
        argument.includes(permissionGlob(`${hostHomePath}/.codex`)),
      ),
    ).toBeFalse();
    expect(
      guardedClaude.args.some((argument) => argument.includes("registry.npmjs.org")),
    ).toBeTrue();
    expect(
      guardedClaude.args.some((argument) => argument.includes("Bash(git status *)")),
    ).toBeTrue();
    expect(guardedClaude.args.some((argument) => argument.includes("Bash(git *)"))).toBeFalse();
    expect(
      guardedClaude.args.some((argument) =>
        argument.includes(`Read(${permissionGlob("/tmp/read-only-git")})`),
      ),
    ).toBeTrue();
    expect(
      guardedClaude.args.some((argument) =>
        argument.includes(`Edit(${permissionGlob("/tmp/read-only-git")})`),
      ),
    ).toBeFalse();
    expect(
      guardedClaude.args.some((argument) =>
        argument.includes(`Write(${permissionGlob("/tmp/read-only-git")})`),
      ),
    ).toBeFalse();
    expect(() =>
      createWorkerInvocation({
        agent: "claude",
        hostHomePath,
        trust: "guarded",
        workerHomePath,
        owner: "quest-dispatch/9/1",
        quest: workerQuest,
        worktreePath: "/tmp/quest,unsafe",
      }),
    ).toThrow("DISPATCH_TRUST_PATH_UNSAFE");
    expect(() =>
      createWorkerInvocation({
        agent: "claude",
        hostHomePath,
        questCliPath: "/opt/quest,unsafe",
        trust: "guarded",
        workerHomePath,
        owner: "quest-dispatch/9/1",
        quest: workerQuest,
        worktreePath: "/tmp/quest-safe",
      }),
    ).toThrow("DISPATCH_TRUST_PATH_UNSAFE");
    if (process.platform !== "win32") {
      expect(() =>
        createWorkerInvocation({
          agent: "claude",
          hostHomePath,
          trust: "guarded",
          workerHomePath,
          owner: "quest-dispatch/9/1",
          quest: workerQuest,
          worktreePath: "/tmp/quest\\unsafe",
        }),
      ).toThrow("DISPATCH_TRUST_PATH_UNSAFE");
    }
    expect(
      guardedClaude.args.some((argument) => argument.includes("Bash(gh pr create *)")),
    ).toBeTrue();
    expect(
      guardedClaude.args.some((argument) => argument.includes("Bash(gh pr view *)")),
    ).toBeTrue();
    expect(guardedClaude.args).not.toContain("--dangerously-skip-permissions");
    expect(fullClaude.args).not.toContain("--add-dir");
    expect(fullClaude.args).not.toContain("--settings");
    expect(fullClaude.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(fullClaude.env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(fullClaude.args.some((argument) => argument.includes(".ssh"))).toBeFalse();
    expect(fullCodex.command).toBe("/opt/bin/codex");
    expect(fullCodex.args).toContain("exec");
    expect(fullCodex.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(fullCodex.args).not.toContain("--sandbox");
    expect(fullCodex.args).toContain("--model");
    expect(fullCodex.args).not.toContain("sandbox-exec");
    expect(guardedCodex.command).toBe("/opt/bin/codex");
    expect(guardedCodex.args).toContain("--ignore-user-config");
    expect(guardedCodex.args).toContain("--ignore-rules");
    expect(guardedCodex.args).toContain("--ephemeral");
    expect(guardedCodex.args).toContain("--skip-git-repo-check");
    expect(guardedCodex.args).toContain("--add-dir");
    expect(guardedCodex.args).toContain("/tmp/quest-42");
    const guardedCodexDirectoryIndex = guardedCodex.args.indexOf("--cd");
    expect(guardedCodex.args[guardedCodexDirectoryIndex + 1]).toBe(workerHomePath);
    expect(guardedCodex.cwd).toBe(workerHomePath);
    expect(guardedCodex.args).toContain("notify=[]");
    expect(guardedCodex.args).toContain("features.plugins=false");
    expect(guardedCodex.args).toContain("features.hooks=false");
    expect(guardedCodex.args).toContain("features.apps=false");
    expect(
      guardedCodex.args.some((argument) =>
        argument.includes('default_permissions="quest_guarded_'),
      ),
    ).toBeTrue();
    expect(
      guardedCodex.args.some(
        (argument) =>
          argument.includes("network={") && argument.includes('"quest.example.test" = "allow"'),
      ),
    ).toBeTrue();
    expect(
      guardedCodex.args.some(
        (argument) => argument.includes("network={") && argument.includes('"github.com" = "allow"'),
      ),
    ).toBeTrue();
    expect(guardedCodex.args.some((argument) => argument.includes("network.domains."))).toBeFalse();
    expect(
      guardedCodex.args.some((argument) => argument.includes(tomlPathLiteral("/tmp/worktree-git"))),
    ).toBeTrue();
    expect(
      guardedCodex.args.some((argument) => argument.includes(tomlPathLiteral("/tmp/repo-git"))),
    ).toBeTrue();
    expect(guardedCodex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(fullCodex.env).toMatchObject({
      HOME: hostHomePath,
      GIT_CONFIG_GLOBAL: join(workerHomePath, ".gitconfig"),
      QUEST_MODEL: "gpt-5",
    });
    expect(fullCodex.env).not.toHaveProperty("CODEX_HOME");
    expect(explicitCodex.env).toMatchObject({
      CODEX_HOME: "/Users/subscription-user/.codex-work",
      HOME: hostHomePath,
    });
    expect(guardedCodex.env).toMatchObject({
      CODEX_HOME: join(hostHomePath, ".codex"),
      HOME: workerHomePath,
    });
    expect(guardedCodex.env?.["QUEST_EFFORT"]).toBeUndefined();
    expect(guardedCodex.env?.["QUEST_MODEL"]).toBeUndefined();
    expect(fullCodex.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(
      guardedCodex.args.some((argument) => argument.includes("quest 42 — make-the-queue-sing:")),
    ).toBeTrue();
    expect(
      fullCodex.args.some((argument) =>
        argument.includes(resolve("/tmp/quest-42", "./.quest-dispatch-brief-42-test.json")),
      ),
    ).toBeTrue();
    expect(reopened.branch).toBe("quest/42-make-the-queue-sing-attempt-2");
  });

  test("allows the canonical target of a symlinked worker CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-cli-link-"));
    try {
      const targetDirectory = join(root, "target", "bin");
      const linkDirectory = join(root, "link");
      await mkdir(targetDirectory, { recursive: true });
      await mkdir(linkDirectory, { recursive: true });
      const targetPath = join(targetDirectory, "claude");
      const linkPath = join(linkDirectory, "claude");
      await writeFile(targetPath, "#!/bin/sh\n");
      await symlink(targetPath, linkPath);

      const invocation = createWorkerInvocation({
        agent: "claude",
        hostHomePath: root,
        trust: "guarded",
        workerCliPath: linkPath,
        workerHomePath: join(root, "worker-home"),
        owner: "quest-dispatch/9/1",
        quest: quest(42, "Make the queue sing"),
        worktreePath: join(root, "worktree"),
      });

      // The dispatcher canonicalizes with realpathSync, which on Windows keeps the 8.3 short
      // form that the async realpath expands; canonicalize the expectation the same way.
      expect(claudeSandboxReadPaths(invocation)).toContain(realpathSync(targetPath));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("allows the lexical node_modules root for symlinked Node worker CLIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-node-cli-link-"));
    try {
      const dependencyRoot = join(root, "node_modules");
      const targetDirectory = join(dependencyRoot, "quest", "dist");
      const linkDirectory = join(dependencyRoot, ".bin");
      await mkdir(targetDirectory, { recursive: true });
      await mkdir(linkDirectory, { recursive: true });
      const targetPath = join(targetDirectory, "cli.js");
      const linkPath = join(linkDirectory, "quest");
      await writeFile(targetPath, "#!/usr/bin/env node\n");
      await symlink(targetPath, linkPath);

      const invocation = createWorkerInvocation({
        agent: "claude",
        hostHomePath: root,
        trust: "guarded",
        workerCliPath: linkPath,
        workerHomePath: join(root, "worker-home"),
        owner: "quest-dispatch/9/1",
        quest: quest(42, "Make the queue sing"),
        worktreePath: join(root, "worktree"),
      });

      const readPaths = claudeSandboxReadPaths(invocation);
      expect(readPaths).toContain(dependencyRoot);
      expect(readPaths).toContain(realpathSync(dependencyRoot));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("allows common user CLI roots without exposing the rest of host home", () => {
    const hostHomePath = "/Users/subscription-user";
    const commonInstall = createWorkerInvocation({
      agent: "claude",
      hostHomePath,
      trust: "guarded",
      workerCliPath: "/opt/bin/claude",
      workerHomePath: "/tmp/quest-worker-home",
      workerSupportPaths: [`${hostHomePath}/.local/bin/node`],
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    const credentialInstall = createWorkerInvocation({
      agent: "claude",
      hostHomePath,
      trust: "guarded",
      workerCliPath: "/opt/bin/claude",
      workerHomePath: "/tmp/quest-worker-home",
      workerSupportPaths: [`${hostHomePath}/.codex/bin/node`],
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });

    expect(claudeSandboxReadPaths(commonInstall)).toContain(
      resolve(`${hostHomePath}/.local/bin/node`),
    );
    expect(
      credentialInstall.args.some((argument) =>
        argument.includes(permissionGlob(`${hostHomePath}/.codex`)),
      ),
    ).toBeFalse();

    const credentialHomeCli = createWorkerInvocation({
      agent: "claude",
      hostHomePath,
      trust: "guarded",
      workerCliPath: `${hostHomePath}/.claude/bin/claude`,
      workerHomePath: "/tmp/quest-worker-home",
      owner: "quest-dispatch/9/1",
      quest: quest(42, "Make the queue sing"),
      worktreePath: "/tmp/quest-42",
    });
    expect(
      credentialHomeCli.args.some((argument) =>
        argument.includes(permissionGlob(`${hostHomePath}/.claude`)),
      ),
    ).toBeFalse();
  });

  test("warns and confirms guarded trust for interactive and non-interactive dispatch", async () => {
    const messages: string[] = [];
    let prompts = 0;
    await confirmDispatchTrust(trustOptions("guarded"), {
      ask: async () => {
        prompts += 1;
        return "yes";
      },
      isInteractive: true,
      write: (message) => messages.push(message),
    });
    expect(prompts).toBe(1);
    expect(messages.join(" ")).toContain("may stall or fail");
    expect(messages.join(" ")).toContain("Trust full is recommended");

    await expect(
      confirmDispatchTrust(trustOptions("guarded"), {
        ask: async () => "",
        isInteractive: false,
        write: (message) => messages.push(message),
      }),
    ).rejects.toThrow("DISPATCH_GUARDED_CONFIRMATION_REQUIRED");
    await confirmDispatchTrust(trustOptions("guarded", true), {
      ask: async () => {
        throw new Error("non-interactive dispatch must not prompt");
      },
      isInteractive: false,
      write: (message) => messages.push(message),
    });
    await confirmDispatchTrust(trustOptions("guarded", true), {
      ask: async () => {
        throw new Error("--yes dispatch must not prompt");
      },
      isInteractive: true,
      write: (message) => messages.push(message),
    });
    await confirmDispatchTrust(trustOptions("full"), {
      ask: async () => {
        throw new Error("full trust must not prompt");
      },
      isInteractive: false,
      write: (message) => messages.push(message),
    });
  });

  test("preflights the Quest CLI version and dispatcher flags", async () => {
    const commands: CommandSpec[] = [];
    const runCommand = async (spec: CommandSpec): Promise<CommandResult> => {
      commands.push(spec);
      if (spec.args.includes("--version")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            command: "version",
            data: { version: "0.7.0" },
            schema: "quest.report/v1",
          }),
        };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: "--claim\n--skip-after-reopens <count>\n",
      };
    };

    await requireQuestCliCompatibility("/opt/bin/quest", "/tmp/repo", runCommand);
    expect(commands.map((command) => command.args)).toEqual([
      ["--format", "json", "--version"],
      ["next", "--help"],
    ]);

    await expect(
      requireQuestCliCompatibility("/opt/bin/quest", "/tmp/repo", async (spec) =>
        spec.args.includes("--version")
          ? {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                command: "version",
                data: { version: "0.6.9" },
                schema: "quest.report/v1",
              }),
            }
          : { exitCode: 0, stderr: "", stdout: "" },
      ),
    ).rejects.toThrow("upgrade Quest CLI to >=0.7.0");

    for (const version of ["0.7.0-alpha", "0.7.0garbage"]) {
      await expect(
        requireQuestCliCompatibility("/opt/bin/quest", "/tmp/repo", async (spec) =>
          spec.args.includes("--version")
            ? {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  command: "version",
                  data: { version },
                  schema: "quest.report/v1",
                }),
              }
            : { exitCode: 0, stderr: "", stdout: "" },
        ),
      ).rejects.toThrow("upgrade Quest CLI to >=0.7.0");
    }
  });

  test("preflights guarded Claude capabilities before dispatch", async () => {
    const compatibleRunner = async (spec: CommandSpec): Promise<CommandResult> => {
      if (spec.command === "which") {
        return { exitCode: 0, stderr: "", stdout: `/usr/bin/${spec.args[0]}` };
      }
      if (spec.command === "uname") {
        return { exitCode: 0, stderr: "", stdout: "5.15.0" };
      }
      if (spec.args.includes("--version")) {
        return { exitCode: 0, stderr: "", stdout: "2.1.169 (Claude Code)" };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          "--add-dir --allowed-tools --permission-mode --safe-mode --settings --setting-sources",
      };
    };

    await requireGuardedClaudeCompatibility("/opt/bin/claude", compatibleRunner, "linux");
    await expect(
      requireGuardedClaudeCompatibility(
        "/opt/bin/claude",
        async (spec) =>
          spec.command === "which" && spec.args[0] === "socat"
            ? { exitCode: 1, stderr: "socat not found", stdout: "" }
            : compatibleRunner(spec),
        "linux",
      ),
    ).rejects.toThrow("socat");
    await expect(
      requireGuardedClaudeCompatibility(
        "/opt/bin/claude",
        async (spec) =>
          spec.command === "uname"
            ? { exitCode: 0, stderr: "", stdout: "4.4.0-Microsoft" }
            : compatibleRunner(spec),
        "linux",
      ),
    ).rejects.toThrow("WSL1");
    await expect(
      requireGuardedClaudeCompatibility(
        "/opt/bin/claude",
        async (spec) =>
          spec.command === "/usr/bin/bwrap"
            ? { exitCode: 1, stderr: "user namespaces unavailable", stdout: "" }
            : compatibleRunner(spec),
        "linux",
      ),
    ).rejects.toThrow("bubblewrap self-test failed");
    await expect(
      requireGuardedClaudeCompatibility(
        "/opt/bin/claude",
        async () => ({ exitCode: 0, stderr: "", stdout: "2.1.168 (Claude Code)" }),
        "linux",
      ),
    ).rejects.toThrow("DISPATCH_GUARDED_CLAUDE_UNAVAILABLE");
    await expect(
      requireGuardedClaudeCompatibility("/opt/bin/claude", compatibleRunner, "win32"),
    ).rejects.toThrow("native Claude sandbox is unavailable");
  });

  test("preflights guarded Codex capabilities before dispatch", async () => {
    const commands: CommandSpec[] = [];
    const compatibleRunner = async (spec: CommandSpec): Promise<CommandResult> => {
      commands.push(spec);
      if (spec.args.includes("--version")) {
        return { exitCode: 0, stderr: "", stdout: "codex-cli 0.144.6" };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          "--add-dir --cd --config --ephemeral --ignore-rules --ignore-user-config --skip-git-repo-check",
      };
    };

    await requireGuardedCodexCompatibility("/opt/bin/codex", compatibleRunner);
    expect(commands).toHaveLength(2);
    await expect(
      requireGuardedCodexCompatibility("/opt/bin/codex", async (spec) =>
        spec.args.includes("--version")
          ? { exitCode: 0, stderr: "", stdout: "codex-cli 0.144.6" }
          : { exitCode: 0, stderr: "", stdout: "--add-dir --cd --config" },
      ),
    ).rejects.toThrow("DISPATCH_GUARDED_CODEX_UNAVAILABLE");
    await expect(
      requireGuardedCodexCompatibility("/opt/bin/codex", async () => ({
        exitCode: 0,
        stderr: "",
        stdout: "codex-cli 0.144.5",
      })),
    ).rejects.toThrow("Codex CLI >=0.144.6");
  });

  test("uses a real linked Git worktree without synthetic worker storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-real-git-test-"));
    const worktreeRoot = join(root, "worktrees");
    const hostHomePath = join(root, "host-home");
    const workerQuest = quest(90, "Real Git worktree");
    const dispatchState: RealDispatchState = { claimed: false };
    let workerInvocation: CommandSpec | null = null;
    try {
      await runSuccessfulRealCommand({ args: ["init", "--quiet"], command: "git", cwd: root });
      await runSuccessfulRealCommand({
        args: ["config", "user.name", "Dispatcher Test"],
        command: "git",
        cwd: root,
      });
      await runSuccessfulRealCommand({
        args: ["config", "user.email", "dispatcher-test@example.com"],
        command: "git",
        cwd: root,
      });
      await writeFile(join(root, "seed.txt"), "seed\n");
      await runSuccessfulRealCommand({ args: ["add", "seed.txt"], command: "git", cwd: root });
      await runSuccessfulRealCommand({
        args: ["commit", "--quiet", "-m", "seed"],
        command: "git",
        cwd: root,
      });

      const runtime: DispatchRuntime = {
        environment: "local:test",
        codexAuthConfig: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        gitRemoteUrl: "https://github.com/example/quest.git",
        gitUserEmail: "worker@example.com",
        gitUserName: "Dispatcher Worker",
        hostHomePath,
        host: "test-host",
        lockScript: "/tools/worktree_lock.py",
        processId: 90,
        pythonCommand: "python3",
        repoRoot: root,
        async runCommand(spec) {
          return runRealDispatchCommand(spec, workerQuest, dispatchState);
        },
        spawnWorker(spec) {
          workerInvocation = spec;
          return workerHandle(
            (async () => {
              expect(spec.env?.["HOME"]).toBe(hostHomePath);
              expect(spec.env).not.toHaveProperty("CODEX_HOME");
              expect(spec.env?.["QUEST_EFFORT"]).toBeUndefined();
              expect(spec.env?.["QUEST_MODEL"]).toBeUndefined();
              for (const environmentName of [
                "GIT_DIR",
                "GIT_COMMON_DIR",
                "GIT_INDEX_FILE",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                "GIT_WORK_TREE",
              ]) {
                expect(spec.env?.[environmentName]).toBeUndefined();
              }
              const initialStatus = await runSuccessfulRealCommand(
                workerGitCommand(spec, ["status", "--short"]),
              );
              expect(initialStatus.stdout).toBe("");
              const metadata = await runSuccessfulRealCommand(
                workerGitCommand(spec, ["rev-parse", "--git-dir", "--git-common-dir"]),
              );
              expect(metadata.stdout.trim().split(/\r?\n/u)).toHaveLength(2);
              await writeFile(join(spec.cwd, "worker.txt"), "worked\n");
              await runSuccessfulRealCommand(workerGitCommand(spec, ["add", "worker.txt"]));
              await runSuccessfulRealCommand(
                workerGitCommand(spec, ["commit", "--quiet", "-m", "worker commit"]),
              );
              const branch = await runSuccessfulRealCommand(
                workerGitCommand(spec, ["symbolic-ref", "--short", "HEAD"]),
              );
              expect(branch.stdout.trim()).toBe("quest/90-real-git-worktree");
              return 0;
            })(),
          );
        },
      };

      const report = await dispatch(
        dispatchOptions(["--concurrency", "1", "--worktree-root", worktreeRoot]),
        runtime,
      );

      expect(report.failures).toBe(0);
      expect(report.workers).toHaveLength(1);
      expect(report.workers[0]?.lockStatus).toBe("handoff");
      if (workerInvocation === null) {
        throw new Error("expected the real Git worker to start");
      }
      const branch = await runSuccessfulRealCommand({
        args: ["log", "-1", "--format=%s", "refs/heads/quest/90-real-git-worktree"],
        command: "git",
        cwd: root,
      });
      expect(branch.stdout.trim()).toBe("worker commit");
      const finalStatus = await runSuccessfulRealCommand({
        args: ["status", "--short"],
        command: "git",
        cwd: join(worktreeRoot, "90-real-git-worktree"),
      });
      expect(finalStatus.stdout).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("claims through quest, locks before creating worktrees, and respects concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-test-"));
    const hostHomePath = join(root, "host-home");
    const commands: CommandSpec[] = [];
    const workerSpecs: CommandSpec[] = [];
    const workers = [quest(1, "First lane"), quest(2, "Second lane")];
    const waitForAllWorkers = workerStartBarrier(workers.length);
    let claimIndex = 0;
    let showIndex = 0;
    let activeWorkers = 0;
    let maximumWorkers = 0;
    let workerBriefContents = "";
    let workerQuestConfig = "";
    try {
      const runtime: DispatchRuntime = {
        environment: "local:test",
        host: "test-host",
        hostHomePath,
        lockScript: "/tools/worktree_lock.py",
        processId: 9,
        pythonCommand: "python3",
        repoRoot: root,
        bunCliPath: "/opt/bin/bun",
        githubToken: "test-token",
        questBackendDomains: ["quest.example.test"],
        questRepositoryName: "quest",
        questStore: {
          backend: "convex",
          deployment: "https://quest.example.test",
          lease_ttl_minutes: 5,
        },
        async runCommand(spec) {
          commands.push(spec);
          await prepareFakeWorktree(spec);
          return fakeCommandResponse(spec, [
            [
              "next",
              () => {
                const item = workers[claimIndex] ?? null;
                claimIndex += 1;
                return { exitCode: 0, stderr: "", stdout: nextReport(item) };
              },
            ],
            [
              "show",
              () => {
                const item = workers[showIndex] ?? quest(1, "First lane");
                showIndex += 1;
                return { exitCode: 0, stderr: "", stdout: showReport(item) };
              },
            ],
          ]);
        },
        spawnWorker(spec) {
          workerSpecs.push(spec);
          return workerHandle(
            (async () => {
              const artifacts = await workerArtifacts(spec);
              workerBriefContents = artifacts.brief;
              workerQuestConfig = artifacts.questConfig;
              const loadedQuestConfig = await loadWorkerQuestConfig(spec);
              if (loadedQuestConfig !== null) {
                expect(loadedQuestConfig.store).toEqual({
                  backend: "convex",
                  convex_deployment: "https://quest.example.test",
                  lease_ttl_minutes: 5,
                });
              }
              activeWorkers += 1;
              maximumWorkers = Math.max(maximumWorkers, activeWorkers);
              await waitForAllWorkers();
              activeWorkers -= 1;
              return 0;
            })(),
          );
        },
      };

      const report = await dispatch(dispatchOptions(["--concurrency", "2"]), runtime);

      expect(report.workers).toHaveLength(2);
      if (workerBriefContents === "") {
        throw new Error("expected the dispatcher to materialize the claimed brief");
      }
      if (!workerBriefContents.includes('"predicted_files"')) {
        throw new Error("expected the worker brief to include predicted files");
      }
      expect(workerQuestConfig).toContain('backend = "convex"');
      expect(workerQuestConfig).toContain('convex_deployment = "https://quest.example.test"');
      expect(workerQuestConfig).toContain("lease_ttl_minutes = 5");
      const claimCommands = commands.filter((command) => command.args.includes("next"));
      expect(claimCommands.length).toBeGreaterThanOrEqual(2);
      expect(claimCommands.every((command) => command.args.includes("--brief"))).toBeTrue();
      expect(report.workers.every((worker) => worker.lockStatus === "handoff")).toBeTrue();
      expect(maximumWorkers).toBe(2);
      const firstLock = commands.findIndex((command) => command.args.includes("claim"));
      const firstWorktree = commands.findIndex((command) => command.args.includes("worktree"));
      expect(firstLock).toBeGreaterThanOrEqual(0);
      expect(firstWorktree).toBeGreaterThan(firstLock);
      expect(commands.filter((command) => command.args.includes("handoff"))).toHaveLength(2);
      expect(workerSpecs).toHaveLength(2);
      expect(workerSpecs.every((spec) => spec.env?.["HOME"] === hostHomePath)).toBeTrue();
      expect(workerSpecs.every((spec) => spec.env?.["CODEX_HOME"] === undefined)).toBeTrue();
      expect(workerSpecs.every((spec) => spec.env?.["GH_TOKEN"] === "test-token")).toBeTrue();
      expect(
        workerSpecs.every(
          (spec) =>
            spec.env?.["GIT_DIR"] === undefined &&
            spec.env?.["GIT_COMMON_DIR"] === undefined &&
            spec.env?.["GIT_INDEX_FILE"] === undefined &&
            spec.env?.["GIT_OBJECT_DIRECTORY"] === undefined &&
            spec.env?.["GIT_ALTERNATE_OBJECT_DIRECTORIES"] === undefined &&
            spec.env?.["GIT_WORK_TREE"] === undefined,
        ),
      ).toBeTrue();
      expect(
        workerSpecs.every((spec) => spec.env?.["QUEST_REPOS"]?.endsWith(':"quest"}')),
      ).toBeTrue();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not retry a failed worker in the same dispatch run", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-worker-failure-test-"));
    let claimCount = 0;
    try {
      const failedQuest = quest(8, "Worker startup failure");
      const runtime: DispatchRuntime = {
        environment: "local:test",
        host: "test-host",
        lockScript: "/tools/worktree_lock.py",
        processId: 15,
        pythonCommand: "python3",
        repoRoot: root,
        async runCommand(spec) {
          await prepareFakeWorktree(spec);
          return fakeCommandResponse(spec, [
            [
              "next",
              () => {
                claimCount += 1;
                return {
                  exitCode: 0,
                  stderr: "",
                  stdout: nextReport(claimCount === 1 ? failedQuest : quest(9, "Second quest")),
                };
              },
            ],
            [
              "show",
              () => ({
                exitCode: 0,
                stderr: "",
                stdout: showReport(failedQuest, "accepted"),
              }),
            ],
          ]);
        },
        spawnWorker() {
          return workerHandle(Promise.resolve(1));
        },
      };

      const report = await dispatch(dispatchOptions(["--concurrency", "1"]), runtime);

      expect(claimCount).toBe(1);
      expect(report.workers).toHaveLength(1);
      expect(report.failures).toBe(1);
      expect(
        report.warnings.some((warning) => warning.includes("stopped after worker")),
      ).toBeTrue();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("deletes a created branch when worker setup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-cleanup-test-"));
    const commands: CommandSpec[] = [];
    let claimed = false;
    try {
      const runtime: DispatchRuntime = {
        environment: "local:test",
        host: "test-host",
        lockScript: "/tools/worktree_lock.py",
        processId: 10,
        pythonCommand: "python3",
        repoRoot: root,
        async runCommand(spec) {
          commands.push(spec);
          await prepareFakeWorktree(spec);
          if (spec.args.includes("--git-dir")) {
            return { exitCode: 1, stderr: "Git metadata unavailable", stdout: "" };
          }
          return fakeCommandResponse(spec, [
            [
              "next",
              () => {
                const item = claimed ? null : quest(6, "Setup failure");
                claimed = true;
                return { exitCode: 0, stderr: "", stdout: nextReport(item) };
              },
            ],
          ]);
        },
        spawnWorker() {
          throw new Error("setup failure must not start a worker");
        },
      };

      const report = await dispatch(dispatchOptions(), runtime);

      expect(report.failures).toBe(1);
      expect(
        commands.some(
          (command) =>
            command.args[0] === "branch" &&
            command.args[1] === "-D" &&
            command.args.includes("quest/6-setup-failure"),
        ),
      ).toBeTrue();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("cleans up a partially registered worktree and its branch when git worktree add fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-partial-worktree-test-"));
    const commands: CommandSpec[] = [];
    const state: PartialWorktreeState = { added: false, branch: "", claimed: false, path: "" };
    try {
      const runtime: DispatchRuntime = {
        environment: "local:test",
        host: "test-host",
        lockScript: "/tools/worktree_lock.py",
        processId: 14,
        pythonCommand: "python3",
        repoRoot: root,
        async runCommand(spec) {
          commands.push(spec);
          return partialWorktreeCommand(spec, state);
        },
        spawnWorker() {
          throw new Error("partial worktree failure must not start a worker");
        },
      };

      const report = await dispatch(dispatchOptions(), runtime);

      expect(report.failures).toBe(1);
      expect(
        commands.some(
          (command) =>
            command.args[0] === "worktree" &&
            command.args[1] === "remove" &&
            command.args.includes(state.path),
        ),
      ).toBeTrue();
      expect(
        commands.some(
          (command) =>
            command.args[0] === "branch" &&
            command.args[1] === "-D" &&
            command.args.includes("quest/7-partial-worktree"),
        ),
      ).toBeTrue();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("renews each claimed quest while its worker runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-heartbeat-test-"));
    let touched = 0;
    let claimed = false;
    let workerStarted = false;
    let resolveWorker: ((exitCode: number) => void) | undefined;
    try {
      const runtime: DispatchRuntime = {
        environment: "local:test",
        host: "test-host",
        heartbeatIntervalMs: 1,
        lockScript: "/tools/worktree_lock.py",
        processId: 11,
        pythonCommand: "python3",
        repoRoot: root,
        async runCommand(spec) {
          await prepareFakeWorktree(spec);
          return fakeCommandResponse(spec, [
            [
              "next",
              () => {
                const item = claimed ? null : quest(3, "Long work");
                claimed = true;
                return { exitCode: 0, stderr: "", stdout: nextReport(item) };
              },
            ],
            [
              "touch",
              () => {
                touched += 1;
                if (workerStarted) {
                  resolveWorker?.(0);
                }
                return {
                  exitCode: 0,
                  stderr: "",
                  stdout: touchReport(quest(3, "Long work")),
                };
              },
            ],
            [
              "show",
              () => ({
                exitCode: 0,
                stderr: "",
                stdout: showReport(quest(3, "Long work")),
              }),
            ],
          ]);
        },
        spawnWorker() {
          workerStarted = true;
          const completion = new Promise<number>((resolve) => {
            resolveWorker = resolve;
          });
          return workerHandle(completion);
        },
      };

      const report = await dispatch(dispatchOptions(), runtime);

      expect(report.workers).toHaveLength(1);
      expect(touched).toBeGreaterThan(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("cancels a worker when lease renewal fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-heartbeat-failure-test-"));
    let claimed = false;
    let touches = 0;
    let workerStarted = false;
    let releaseTouchFailure: (() => void) | undefined;
    let cancelled = false;
    let resolveWorker: ((exitCode: number) => void) | undefined;
    try {
      const runtime: DispatchRuntime = {
        environment: "local:test",
        host: "test-host",
        heartbeatIntervalMs: 5,
        lockScript: "/tools/worktree_lock.py",
        processId: 12,
        pythonCommand: "python3",
        repoRoot: root,
        async runCommand(spec) {
          await prepareFakeWorktree(spec);
          if (spec.args.includes("touch")) {
            touches += 1;
            if (touches === 1) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: touchReport(quest(4, "Lease failure")),
              };
            }
            return new Promise<CommandResult>((resolve) => {
              releaseTouchFailure = () =>
                resolve({ exitCode: 1, stderr: "lease store unavailable", stdout: "" });
              if (workerStarted) {
                releaseTouchFailure();
              }
            });
          }
          return fakeCommandResponse(spec, [
            [
              "next",
              () => {
                const item = claimed ? null : quest(4, "Lease failure");
                claimed = true;
                return { exitCode: 0, stderr: "", stdout: nextReport(item) };
              },
            ],
            [
              "show",
              () => ({
                exitCode: 0,
                stderr: "",
                stdout: showReport(quest(4, "Lease failure"), "accepted"),
              }),
            ],
          ]);
        },
        spawnWorker() {
          workerStarted = true;
          releaseTouchFailure?.();
          const completion = new Promise<number>((resolve) => {
            resolveWorker = resolve;
          });
          return {
            completion,
            async cancel() {
              cancelled = true;
              resolveWorker?.(137);
            },
          };
        },
      };

      const report = await dispatch(dispatchOptions(), runtime);

      expect(cancelled).toBeTrue();
      expect(report.workers[0]?.exitCode).toBe(1);
      expect(
        report.warnings.some((warning) => warning.includes("lease renewal failed")),
      ).toBeTrue();
      expect(report.failures).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails and cancels a worker when lease renewal stalls", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-dispatch-heartbeat-timeout-test-"));
    let claimed = false;
    let cancelled = false;
    let workerStarted = false;
    let releaseTouchStall: (() => void) | undefined;
    let resolveWorker: ((exitCode: number) => void) | undefined;
    try {
      const runtime: DispatchRuntime = {
        environment: "local:test",
        heartbeatIntervalMs: 1,
        heartbeatTimeoutMs: 5,
        host: "test-host",
        lockScript: "/tools/worktree_lock.py",
        processId: 13,
        pythonCommand: "python3",
        repoRoot: root,
        async runCommand(spec) {
          await prepareFakeWorktree(spec);
          if (spec.args.includes("touch")) {
            return new Promise<CommandResult>((resolve) => {
              releaseTouchStall = () =>
                resolve({
                  exitCode: 124,
                  stderr: `command timed out after ${spec.timeoutMs ?? 0}ms`,
                  stdout: "",
                });
              if (workerStarted) {
                releaseTouchStall();
              }
            });
          }
          return fakeCommandResponse(spec, [
            [
              "next",
              () => {
                const item = claimed ? null : quest(5, "Lease timeout");
                claimed = true;
                return { exitCode: 0, stderr: "", stdout: nextReport(item) };
              },
            ],
            [
              "show",
              () => ({
                exitCode: 0,
                stderr: "",
                stdout: showReport(quest(5, "Lease timeout"), "accepted"),
              }),
            ],
          ]);
        },
        spawnWorker() {
          workerStarted = true;
          releaseTouchStall?.();
          const completion = new Promise<number>((resolve) => {
            resolveWorker = resolve;
          });
          return {
            completion,
            async cancel() {
              cancelled = true;
              resolveWorker?.(137);
            },
          };
        },
      };

      const report = await dispatch(dispatchOptions(), runtime);

      expect(cancelled).toBeTrue();
      expect(report.workers[0]?.exitCode).toBe(1);
      expect(report.warnings.some((warning) => warning.includes("timed out"))).toBeTrue();
      expect(report.failures).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
