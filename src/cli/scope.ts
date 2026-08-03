import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";

import { z } from "zod";

import { resolveRepositoryName } from "../config";
import type { Config } from "../schema";
import { questScopeSchema } from "../schema";
import { type GitIdentity, parseGitIdentityConfig } from "./identity";

const nonEmptyOptionSchema = z.string().trim().min(1);

export const cliFormatSchema = z.enum(["human", "json"]);
export type CliFormat = z.infer<typeof cliFormatSchema>;

export const globalCliOptionsSchema = z
  .strictObject({
    directory: nonEmptyOptionSchema.optional(),
    repo: nonEmptyOptionSchema.optional(),
    all: z.boolean().default(false),
    format: cliFormatSchema.default("human"),
    theme: nonEmptyOptionSchema.optional(),
    version: z.boolean().default(false),
  })
  .refine((options) => !(options.all && options.repo !== undefined), {
    message: "--repo and --all cannot be used together",
    path: ["repo"],
  });
export type GlobalCliOptions = z.infer<typeof globalCliOptionsSchema>;

export const resolvedCliScopeSchema = z.strictObject({
  scope: questScopeSchema,
  working_directory: nonEmptyOptionSchema,
  git_root: nonEmptyOptionSchema.optional(),
});
export type ResolvedCliScope = z.infer<typeof resolvedCliScopeSchema>;

export type GitRootLocator = (workingDirectory: string) => Promise<string>;
export type GitIdentityLocator = (workingDirectory: string) => Promise<GitIdentity>;
export type WorkingDirectoryValidator = (workingDirectory: string) => Promise<void>;

export interface ResolveCliScopeOptions {
  readonly config: Config;
  readonly flags: GlobalCliOptions;
  readonly initialWorkingDirectory: string;
  readonly locateGitRoot: GitRootLocator;
  readonly validateWorkingDirectory: WorkingDirectoryValidator;
}

export class ScopeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeResolutionError";
  }
}

export function locateGitRoot(workingDirectory: string): Promise<string> {
  return new Promise((resolveRoot, reject) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: workingDirectory, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          reject(
            new ScopeResolutionError(
              `cannot detect a git repository from ${workingDirectory}; use --repo or --all`,
            ),
          );
          return;
        }

        const root = stdout.trim();
        if (root === "") {
          reject(new ScopeResolutionError(`git returned an empty root for ${workingDirectory}`));
          return;
        }
        resolveRoot(root);
      },
    );
  });
}

export function locateGitIdentity(workingDirectory: string): Promise<GitIdentity> {
  return new Promise((resolveIdentity) => {
    execFile(
      "git",
      ["config", "--get-regexp", "^user\\.(email|name)$"],
      { cwd: workingDirectory, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          resolveIdentity({});
          return;
        }
        resolveIdentity(parseGitIdentityConfig(stdout));
      },
    );
  });
}

export async function resolveCliScope(options: ResolveCliScopeOptions): Promise<ResolvedCliScope> {
  const flags = globalCliOptionsSchema.parse(options.flags);
  const workingDirectory = resolve(options.initialWorkingDirectory, flags.directory ?? ".");
  try {
    await options.validateWorkingDirectory(workingDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScopeResolutionError(detail);
  }

  if (flags.all) {
    return resolvedCliScopeSchema.parse({
      scope: { repo: null },
      working_directory: workingDirectory,
    });
  }

  if (flags.repo !== undefined) {
    return resolvedCliScopeSchema.parse({
      scope: { repo: resolveRepositoryName(options.config, flags.repo) },
      working_directory: workingDirectory,
    });
  }

  const gitRoot = await options.locateGitRoot(workingDirectory);
  const detectedRepo = basename(gitRoot);
  const repo = resolveRepositoryName(options.config, detectedRepo);
  return resolvedCliScopeSchema.parse({
    scope: { repo },
    working_directory: workingDirectory,
    git_root: gitRoot,
  });
}
