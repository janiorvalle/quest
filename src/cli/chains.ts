import { type Command, Option } from "commander";
import { z } from "zod";

import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import type { Chain, ChainType, Config, QuestScope } from "../schema";
import { chainSchema, chainTypeSchema, questSchema } from "../schema";
import {
  addQuestChain,
  ChainCommandError,
  type ChainMutationResult,
  type ChainTreeLine,
  type ChainTreeResult,
  removeQuestChain,
  showQuestChains,
} from "../services";
import type { Clock, QuestStore } from "../store";
import type { CliFormat } from "./scope";

const displayIdSchema = z.coerce.number().int().positive();

const chainMutationDataSchema = z.strictObject({
  changed: z.boolean(),
  link: chainSchema,
  outcome: z.enum(["added", "exists", "missing", "removed"]),
});

const chainTreeLineSchema = z.strictObject({
  blocked: z.boolean(),
  cycle: z.boolean(),
  depth: z.int().nonnegative(),
  link_type: chainTypeSchema.nullable(),
  quest: questSchema,
});

const chainTreeDataSchema = z.strictObject({
  trees: z.array(
    z.strictObject({
      lines: z.array(chainTreeLineSchema),
      root_id: z.int().positive(),
    }),
  ),
});

interface ChainAddCliRequest {
  readonly command: "chain-add";
  readonly id: number;
  readonly target: number;
  readonly type: ChainType;
}

interface ChainRemoveCliRequest {
  readonly command: "chain-rm";
  readonly id: number;
  readonly target: number;
}

interface ChainShowCliRequest {
  readonly command: "chain-show";
  readonly id?: number | undefined;
}

export type ChainCliRequest = ChainAddCliRequest | ChainRemoveCliRequest | ChainShowCliRequest;

export interface ChainRequestCapture {
  set(request: ChainCliRequest): void;
}

export interface ExecuteChainCliOptions {
  readonly config: Config;
  readonly format: CliFormat;
  readonly identity: string | undefined;
  readonly identityWarnings: readonly string[];
  readonly output: CliOutputBoundary;
  readonly ports: {
    readonly clock: Clock;
    readonly questStore: QuestStore;
  };
  readonly request: ChainCliRequest;
  readonly scope: QuestScope;
  readonly scopeWarnings?: readonly string[] | undefined;
}

export class ChainCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainCliUsageError";
  }
}

function idArgument(value: string): number {
  return displayIdSchema.parse(value);
}

function optionId(command: Command, name: string): number | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : displayIdSchema.parse(value);
}

export function registerChainCommands(program: Command, capture: ChainRequestCapture): void {
  const chain = program.command("chain").description("manage quest chains");

  chain
    .command("add")
    .description("add a quest chain link")
    .argument("<id>")
    .addOption(new Option("--requires <id>").conflicts("duplicateOf"))
    .addOption(new Option("--duplicate-of <id>").conflicts("requires"))
    .action(function (this: Command, id: string) {
      const requires = optionId(this, "requires");
      const duplicateOf = optionId(this, "duplicateOf");
      if (requires !== undefined) {
        capture.set({
          command: "chain-add",
          id: idArgument(id),
          target: requires,
          type: "requires",
        });
        return;
      }
      if (duplicateOf === undefined) {
        throw new ChainCliUsageError("chain add requires --requires or --duplicate-of");
      }
      capture.set({
        command: "chain-add",
        id: idArgument(id),
        target: duplicateOf,
        type: "duplicate-of",
      });
    });

  chain
    .command("rm")
    .description("remove a requires link")
    .argument("<id>")
    .requiredOption("--requires <id>")
    .action(function (this: Command, id: string) {
      const target = optionId(this, "requires");
      if (target === undefined) {
        throw new ChainCliUsageError("chain rm requires --requires");
      }
      capture.set({
        command: "chain-rm",
        id: idArgument(id),
        target,
      });
    });

  chain
    .command("show")
    .description("render quest chain trees")
    .argument("[id]")
    .action((id: string | undefined) => {
      capture.set({
        command: "chain-show",
        ...(id === undefined ? {} : { id: idArgument(id) }),
      });
    });
}

function requireIdentity(identity: string | undefined): string {
  if (identity === undefined) {
    throw new ChainCliUsageError("identity is not configured; set identity in config");
  }
  return identity;
}

function writeWarnings(output: CliOutputBoundary, warnings: readonly string[]): void {
  for (const warning of warnings) {
    output.write(`warning: ${warning}\n`);
  }
}

function reportWarnings(options: ExecuteChainCliOptions, warnings: readonly string[]): string[] {
  return [...(options.scopeWarnings ?? []), ...options.identityWarnings, ...warnings];
}

async function writeMutationResult(
  options: ExecuteChainCliOptions,
  result: ChainMutationResult,
): Promise<ExitCode> {
  const command = options.request.command === "chain-add" ? "chain add" : "chain rm";
  if (options.format === "json") {
    const report = buildQuestReport(chainMutationDataSchema, {
      command,
      generated_at: await options.ports.clock.now(),
      filters: { repo: options.scope.repo },
      warnings: reportWarnings(options, result.warnings),
      data: {
        changed: result.changed,
        link: result.link,
        outcome: result.outcome,
      },
    });
    options.output.write(formatQuestReport(report));
  } else {
    writeWarnings(options.output, [...options.identityWarnings, ...result.warnings]);
    const verb =
      result.outcome === "removed"
        ? "removed"
        : result.outcome === "missing"
          ? "was already absent"
          : result.outcome === "added"
            ? "added"
            : "was already present";
    options.output.write(
      `${result.link.type} link ${result.link.quest_id} -> ${result.link.target_id} ${verb}\n`,
    );
  }
  return EXIT_SUCCESS;
}

function formatTreeLine(line: ChainTreeLine): string {
  const state = [
    line.quest.status,
    ...(line.blocked ? ["blocked"] : []),
    ...(line.cycle ? ["cycle"] : []),
  ].join(", ");
  const quest = `${line.quest.id} ${line.quest.title} [${state}]`;
  if (line.depth === 0 || line.link_type === null) {
    return quest;
  }
  return `${"  ".repeat(line.depth - 1)}- ${line.link_type}: ${quest}`;
}

async function writeTreeResult(
  options: ExecuteChainCliOptions,
  result: ChainTreeResult,
): Promise<ExitCode> {
  if (options.format === "json") {
    const report = buildQuestReport(chainTreeDataSchema, {
      command: "chain show",
      generated_at: await options.ports.clock.now(),
      filters: {
        repo: options.scope.repo,
        id: options.request.command === "chain-show" ? (options.request.id ?? null) : null,
      },
      warnings: reportWarnings(options, []),
      data: {
        trees: result.trees.map((tree) => ({
          lines: [...tree.lines],
          root_id: tree.root_id,
        })),
      },
    });
    options.output.write(formatQuestReport(report));
    return EXIT_SUCCESS;
  }

  if (result.trees.length === 0) {
    options.output.write("No chains.\n");
    return EXIT_SUCCESS;
  }
  result.trees.forEach((tree, index) => {
    if (index > 0) {
      options.output.write("\n");
    }
    for (const line of tree.lines) {
      options.output.write(`${formatTreeLine(line)}\n`);
    }
  });
  return EXIT_SUCCESS;
}

function linkFor(request: ChainAddCliRequest | ChainRemoveCliRequest): Chain {
  return {
    quest_id: request.id,
    target_id: request.target,
    type: request.command === "chain-add" ? request.type : "requires",
  };
}

export async function executeChainCli(options: ExecuteChainCliOptions): Promise<ExitCode> {
  const { request } = options;
  switch (request.command) {
    case "chain-add":
      return writeMutationResult(
        options,
        await addQuestChain(
          options.ports.questStore,
          options.scope,
          linkFor(request),
          requireIdentity(options.identity),
          options.config.guild ?? null,
        ),
      );
    case "chain-rm":
      return writeMutationResult(
        options,
        await removeQuestChain(
          options.ports.questStore,
          options.scope,
          linkFor(request),
          requireIdentity(options.identity),
          options.config.guild ?? null,
        ),
      );
    case "chain-show":
      return writeTreeResult(
        options,
        await showQuestChains(options.ports.questStore, options.scope, request.id),
      );
  }
}

export function isChainCommandError(error: unknown): error is ChainCommandError {
  return error instanceof ChainCommandError;
}

export function isChainCliRequest(
  request: ChainCliRequest | { readonly command: string },
): request is ChainCliRequest {
  switch (request.command) {
    case "chain-add":
    case "chain-rm":
    case "chain-show":
      return true;
    default:
      return false;
  }
}
