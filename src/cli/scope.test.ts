import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import type { Config } from "../schema";
import { globalCliOptionsSchema, resolveCliScope } from "./scope";

const config = {
  store: { backend: "sqlite" },
  repos: { quest: "quest-cli" },
  areas: {},
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

const routedConfig = {
  ...config,
  repos: {
    "streamlyne-marketing": {
      store: { backend: "convex", deployment: "dev:marketing" },
    },
  },
} satisfies Config;

const workDirectory = join(resolve("/"), "work");
const questRoot = join(workDirectory, "quest");
const questSource = join(questRoot, "src");
const otherRoot = join(workDirectory, "other");
const outsideGit = join(resolve("/"), "outside", "git");
const missingDirectory = join(resolve("/"), "missing");

describe("CLI scope resolution", () => {
  test("detects the cwd git root and applies its configured alias", async () => {
    const calls: string[] = [];
    const result = await resolveCliScope({
      config,
      flags: globalCliOptionsSchema.parse({}),
      initialWorkingDirectory: questSource,
      locateGitRoot: (workingDirectory) => {
        calls.push(workingDirectory);
        return Promise.resolve(questRoot);
      },
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(calls).toEqual([questSource]);
    expect(result).toEqual({
      scope: { repo: "quest-cli" },
      working_directory: questSource,
      git_root: questRoot,
    });
  });

  test("-C changes the directory used for git-root detection", async () => {
    const calls: string[] = [];
    const result = await resolveCliScope({
      config,
      flags: globalCliOptionsSchema.parse({ directory: "../other" }),
      initialWorkingDirectory: questRoot,
      locateGitRoot: (workingDirectory) => {
        calls.push(workingDirectory);
        return Promise.resolve(otherRoot);
      },
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(calls).toEqual([otherRoot]);
    expect(result.scope).toEqual({ repo: "other" });
  });

  test("--repo selects an explicit repo without invoking git", async () => {
    let called = false;
    const result = await resolveCliScope({
      config,
      flags: globalCliOptionsSchema.parse({ repo: "other-app" }),
      initialWorkingDirectory: outsideGit,
      locateGitRoot: () => {
        called = true;
        return Promise.reject(new Error("must not run"));
      },
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(called).toBeFalse();
    expect(result).toEqual({
      scope: { repo: "other-app" },
      working_directory: outsideGit,
    });
  });

  test("--repo applies configured aliases before dispatch", async () => {
    const result = await resolveCliScope({
      config,
      flags: globalCliOptionsSchema.parse({ repo: "quest" }),
      initialWorkingDirectory: outsideGit,
      locateGitRoot: () => Promise.reject(new Error("must not run")),
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(result.scope).toEqual({ repo: "quest-cli" });
  });

  test("--all selects every repo without invoking git", async () => {
    let called = false;
    const result = await resolveCliScope({
      config,
      flags: globalCliOptionsSchema.parse({ all: true }),
      initialWorkingDirectory: outsideGit,
      locateGitRoot: () => {
        called = true;
        return Promise.reject(new Error("must not run"));
      },
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(called).toBeFalse();
    expect(result.scope).toEqual({ repo: null });
  });

  test("rejects mutually exclusive explicit scopes at the CLI boundary", () => {
    expect(() => globalCliOptionsSchema.parse({ repo: "quest", all: true })).toThrow(
      "--repo and --all cannot be used together",
    );
  });

  test("validates -C before an explicit scope bypasses git detection", async () => {
    const promise = resolveCliScope({
      config,
      flags: globalCliOptionsSchema.parse({ directory: missingDirectory, repo: "quest" }),
      initialWorkingDirectory: questRoot,
      locateGitRoot: () => Promise.reject(new Error("must not run")),
      validateWorkingDirectory: () =>
        Promise.reject(new Error(`working directory is not accessible: ${missingDirectory}`)),
    });

    await expect(promise).rejects.toThrow(
      `working directory is not accessible: ${missingDirectory}`,
    );
  });

  test("warns when the git-root folder falls back to the default store", async () => {
    const result = await resolveCliScope({
      config: routedConfig,
      flags: globalCliOptionsSchema.parse({}),
      initialWorkingDirectory: questSource,
      locateGitRoot: () => Promise.resolve(join(workDirectory, "marketing")),
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(result.warnings).toEqual([
      'detected repository "marketing" is not configured, so Quest fell back to the default sqlite store; configured repository "streamlyne-marketing" uses a non-default convex store. Add [repos] marketing = "streamlyne-marketing" or rerun with --repo streamlyne-marketing',
    ]);
    expect(result.scope).toEqual({ repo: "marketing" });
  });

  test("does not warn after adding the checkout alias", async () => {
    const result = await resolveCliScope({
      config: {
        ...routedConfig,
        repos: {
          marketing: "streamlyne-marketing",
          ...routedConfig.repos,
        },
      },
      flags: globalCliOptionsSchema.parse({}),
      initialWorkingDirectory: questSource,
      locateGitRoot: () => Promise.resolve(join(workDirectory, "marketing")),
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(result.warnings).toBeUndefined();
    expect(result.scope).toEqual({ repo: "streamlyne-marketing" });
  });
});
