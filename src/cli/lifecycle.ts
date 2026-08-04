import { execFile } from "node:child_process";
import { Argument, type Command, Option } from "commander";
import { z } from "zod";

import { initialStatusForKind, statusForVerdict } from "../domain";
import type { EvidenceFileReader } from "../evidence";
import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import type {
  Config,
  Evidence,
  NewQuest,
  Quest,
  QuestScope,
  QuestTransition,
  Verdict,
} from "../schema";
import {
  evidenceSchema,
  MAX_LEASE_TTL_MINUTES,
  questKindSchema,
  questSchema,
  questStatusSchema,
  verdictSchema,
} from "../schema";
import {
  acceptLifecycleQuest,
  addLifecycleQuest,
  getNextQuest,
  LifecycleCommandError,
  type LifecycleSignoffBatchResult,
  type LifecycleTransitionOptions,
  type NextLaneConflict,
  type NextQuestResult,
  type PullRequestMergeChecker,
  type PullRequestMergeState,
  type QuestBrief,
  type SessionAttribution,
  signoffLifecycleQuests,
  touchLifecycleQuest,
  transitionLifecycleQuest,
} from "../services";
import type { BlobStore, Clock, QuestStore } from "../store";
import { renderQuestBriefMarkdown } from "./brief";
import { withCompletionChoices } from "./completions";
import type { CliPrompter } from "./prompt";
import { briefDataSchema, serializeQuestBrief } from "./query";
import type { CliFormat } from "./scope";

const nonEmptyOptionSchema = z.string().trim().min(1);
const displayIdSchema = z.coerce.number().int().positive();
const prioritySchema = z.coerce.number().int().min(1).max(3);
const reopenLimitSchema = z.coerce.number().int().min(1);
const leaseTtlSchema = z.coerce.number().int().positive().max(MAX_LEASE_TTL_MINUTES);
const jsonSourceSchema = z.literal("-");

const addJsonInputSchema = z.strictObject({
  area: nonEmptyOptionSchema.optional(),
  description: z.string().optional(),
  evidence: z.array(z.string().trim().min(1)).optional(),
  force: z.boolean().optional(),
  guild: nonEmptyOptionSchema.optional(),
  kind: z.enum(["bug", "task"]).optional(),
  predicted_files: z.array(z.string().trim().min(1)).optional(),
  status: questStatusSchema.optional(),
  title: z.string().trim().min(1),
  verdict: z.string().trim().min(1).optional(),
});

const updateJsonInputSchema = z.strictObject({
  add_evidence: z.array(z.string().trim().min(1)).optional(),
  area: nonEmptyOptionSchema.optional(),
  clear_guild: z.boolean().optional(),
  description: z.string().optional(),
  guild: nonEmptyOptionSchema.optional(),
  notes: z.string().optional(),
  predicted_files: z.array(z.string().trim().min(1)).optional(),
  priority: z.number().int().min(1).max(3).optional(),
  title: z.string().trim().min(1).optional(),
});
const verdictCompletionChoices: readonly string[] = verdictSchema.options.filter(
  (verdict) => verdict !== "duplicate",
);

const pullRequestMergeStateSchema = z.object({
  state: z.string().trim().min(1),
  url: z.string().trim().min(1),
});

function createPullRequestMergeChecker(workingDirectory: string): PullRequestMergeChecker {
  return (pullRequest) =>
    new Promise<PullRequestMergeState | undefined>((resolve) => {
      execFile(
        "gh",
        ["pr", "view", pullRequest, "--json", "state,url"],
        { cwd: workingDirectory, encoding: "utf8", timeout: 5_000 },
        (error, stdout) => {
          if (error !== null) {
            resolve(undefined);
            return;
          }
          try {
            const parsed = pullRequestMergeStateSchema.parse(JSON.parse(String(stdout)));
            resolve(parsed);
          } catch {
            resolve(undefined);
          }
        },
      );
    });
}

const turnInJsonInputSchema = z.strictObject({
  actual_files: z.array(z.string().trim().min(1)).optional(),
  evidence: z.array(z.string().trim().min(1)).optional(),
  pr: nonEmptyOptionSchema.optional(),
  summary: nonEmptyOptionSchema.optional(),
});

const duplicateCandidateSchema = z.strictObject({
  id: z.int().positive(),
  score: z.number().min(0).max(1),
  status: questStatusSchema,
  title: z.string(),
});

const mutationDataSchema = z.strictObject({
  changed: z.boolean(),
  evidence: z.array(evidenceSchema),
  quest: questSchema,
});

const signoffItemDataSchema = mutationDataSchema.extend({ warnings: z.array(z.string()) });
const signoffDataSchema = z.strictObject({
  changed: z.boolean(),
  evidence: z.array(evidenceSchema),
  quests: z.array(signoffItemDataSchema),
});

const acceptMutationDataSchema = mutationDataSchema.extend({
  lease_expires_at: z.iso.datetime({ offset: true }).nullable(),
});

const addDataSchema = z.strictObject({
  candidates: z.array(duplicateCandidateSchema),
  evidence: z.array(evidenceSchema),
  outcome: z.enum(["created", "duplicates", "replayed"]),
  quest: questSchema.nullable(),
});

const nextDataSchema = z.strictObject({
  claimed: z.boolean(),
  quest: questSchema.nullable(),
});

const nextBriefDataSchema = nextDataSchema.extend({
  brief: briefDataSchema.nullable(),
});

interface AddCliRequest {
  readonly command: "add";
  readonly area?: string | undefined;
  readonly description?: string | undefined;
  readonly evidence: readonly string[];
  readonly force: boolean;
  readonly guild?: string | undefined;
  readonly kind?: string | undefined;
  readonly jsonSource?: string | undefined;
  readonly predictedFiles: readonly string[];
  readonly status?: string | undefined;
  readonly title?: string | undefined;
  readonly verdict?: string | undefined;
}

interface NextCliRequest {
  readonly allowConflict: boolean;
  readonly brief: boolean;
  readonly claim: boolean;
  readonly command: "next";
  readonly leaseTtlMinutes?: number | undefined;
  readonly skipAfterReopens?: number | undefined;
}

interface AcceptCliRequest {
  readonly command: "accept";
  readonly force: boolean;
  readonly id: number;
  readonly leaseTtlMinutes?: number | undefined;
  readonly owner?: string | undefined;
}

interface TouchCliRequest {
  readonly command: "touch";
  readonly id: number;
  readonly leaseTtlMinutes?: number | undefined;
  readonly owner?: string | undefined;
}

interface AbandonCliRequest {
  readonly command: "abandon";
  readonly id: number;
  readonly owner?: string | undefined;
}

interface VerdictCliRequest {
  readonly command: "verdict";
  readonly id: number;
  readonly notes?: string | undefined;
  readonly owner?: string | undefined;
  readonly retest: boolean;
  readonly verdict: string;
}

interface TurnInCliRequest {
  readonly actualFiles: readonly string[];
  readonly command: "turnin";
  readonly evidence: readonly string[];
  readonly id: number;
  readonly jsonSource?: string | undefined;
  readonly owner?: string | undefined;
  readonly pr?: string | undefined;
  readonly summary?: string | undefined;
}

interface CompleteCliRequest {
  readonly command: "complete";
  readonly evidence: readonly string[];
  readonly id: number;
  readonly owner?: string | undefined;
}

interface CancelCliRequest {
  readonly command: "cancel";
  readonly id: number;
  readonly owner?: string | undefined;
  readonly reason?: string | undefined;
}

interface ReopenCliRequest {
  readonly command: "reopen";
  readonly id: number;
  readonly notes?: string | undefined;
  readonly owner?: string | undefined;
}

interface UpdateCliRequest {
  readonly addEvidence: readonly string[];
  readonly area?: string | undefined;
  readonly clearGuild: boolean;
  readonly command: "update";
  readonly description?: string | undefined;
  readonly guild?: string | undefined;
  readonly id: number;
  readonly jsonSource?: string | undefined;
  readonly notes?: string | undefined;
  readonly owner?: string | undefined;
  readonly predictedFiles?: readonly string[] | undefined;
  readonly priority?: number | undefined;
  readonly title?: string | undefined;
}

interface SignoffCliRequest {
  readonly command: "signoff";
  readonly evidence: readonly string[];
  readonly ids: readonly number[];
  readonly notes?: string | undefined;
}

export type LifecycleCliRequest =
  | AddCliRequest
  | NextCliRequest
  | AcceptCliRequest
  | TouchCliRequest
  | AbandonCliRequest
  | VerdictCliRequest
  | TurnInCliRequest
  | CompleteCliRequest
  | CancelCliRequest
  | ReopenCliRequest
  | UpdateCliRequest
  | SignoffCliRequest;

export interface LifecycleRequestCapture {
  set(request: LifecycleCliRequest): void;
}

export interface LifecycleCliPorts {
  readonly blobStore: BlobStore;
  readonly checkPullRequestMerge?: PullRequestMergeChecker;
  readonly clock: Clock;
  readonly evidenceFiles: EvidenceFileReader;
  readonly questStore: QuestStore;
}

export interface ExecuteLifecycleCliOptions {
  readonly config: Config;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly format: CliFormat;
  readonly identity: string | undefined;
  readonly identityWarnings: readonly string[];
  readonly isTty: boolean;
  readonly output: CliOutputBoundary;
  readonly ports: LifecycleCliPorts;
  readonly prompter: CliPrompter;
  readonly request: LifecycleCliRequest;
  readonly readStdin?: (() => Promise<string>) | undefined;
  readonly scope: QuestScope;
  readonly workingDirectory: string;
}

export class LifecycleCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleCliUsageError";
  }
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function sessionAttributionFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): SessionAttribution {
  const model = environmentValue(environment, "QUEST_MODEL");
  const effort = environmentValue(environment, "QUEST_EFFORT");
  return {
    ...(effort === undefined ? {} : { session_effort: effort }),
    ...(model === undefined ? {} : { session_model: model }),
  };
}

function appendOption(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function optionalString(command: Command, name: string): string | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : nonEmptyOptionSchema.parse(value);
}

function optionalLeaseTtl(command: Command): number | undefined {
  const value = command.getOptionValue("lease");
  if (value === undefined) {
    return undefined;
  }
  const parsed = leaseTtlSchema.safeParse(value);
  if (!parsed.success) {
    throw new LifecycleCliUsageError(
      `--lease expects a positive whole number of minutes no greater than ${MAX_LEASE_TTL_MINUTES}, for example --lease 1440`,
    );
  }
  return parsed.data;
}

function acceptLeaseOptions(request: AcceptCliRequest): { readonly leaseTtlMinutes?: number } {
  return request.leaseTtlMinutes === undefined ? {} : { leaseTtlMinutes: request.leaseTtlMinutes };
}

function optionalText(command: Command, name: string): string | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : z.string().parse(value);
}

function stringList(command: Command, name: string): string[] {
  return z.array(nonEmptyOptionSchema).parse(command.getOptionValue(name) ?? []);
}

function optionalStringList(command: Command, name: string): string[] | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : z.array(nonEmptyOptionSchema).parse(value);
}

function booleanOption(command: Command, name: string): boolean {
  return z.boolean().parse(command.getOptionValue(name) ?? false);
}

function idArgument(value: string): number {
  return displayIdSchema.parse(value);
}

function requireJsonSource(value: string | undefined): string | undefined {
  return value === undefined ? undefined : jsonSourceSchema.parse(value);
}

function hasCliOption(command: Command, name: string): boolean {
  return command.getOptionValueSource(name) === "cli";
}

export function registerLifecycleCommands(
  program: Command,
  capture: LifecycleRequestCapture,
): void {
  program
    .command("add")
    .description("file a new quest")
    .argument("[title]")
    .addOption(new Option("--kind <kind>").choices(["bug", "task"]))
    .option("--area <area>")
    .option("--desc <text>")
    .option("--guild <guild>", "restrict the quest to an agent guild")
    .option("--evidence <path...>", "attach report evidence", appendOption, [])
    .option("--force", "file despite fuzzy duplicate candidates")
    .addOption(new Option("--status <status>").choices(questStatusSchema.options))
    .addOption(withCompletionChoices(new Option("--verdict <verdict>"), verdictCompletionChoices))
    .option("--predicted-files <path...>", "record files the quest is likely to change")
    .option("--json <source>", "read the command input as JSON from stdin (use -)")
    .action(function (this: Command, title: string | undefined) {
      const jsonSource = requireJsonSource(this.getOptionValue("json"));
      if (
        jsonSource !== undefined &&
        (title !== undefined ||
          [
            "kind",
            "area",
            "desc",
            "guild",
            "evidence",
            "force",
            "status",
            "verdict",
            "predictedFiles",
          ].some((name) => hasCliOption(this, name)))
      ) {
        throw new LifecycleCliUsageError("add --json - cannot be combined with title or add flags");
      }
      capture.set({
        command: "add",
        area: optionalString(this, "area"),
        description: optionalText(this, "desc"),
        evidence: stringList(this, "evidence"),
        force: booleanOption(this, "force"),
        guild: optionalString(this, "guild"),
        kind: optionalString(this, "kind"),
        jsonSource,
        predictedFiles: stringList(this, "predictedFiles"),
        status: optionalString(this, "status"),
        title,
        verdict: optionalString(this, "verdict"),
      });
    });

  program
    .command("next")
    .description("suggest the next unblocked quest")
    .option("--claim", "atomically accept the suggestion")
    .option("--allow-conflict", "claim despite a hard lane conflict")
    .option("--brief", "include the full context package; requires --claim")
    .option("--lease <minutes>", "set this claim's lease length in minutes")
    .option(
      "--skip-after-reopens <count>",
      "leave quests reopened this many times or more for a human",
    )
    .action(function (this: Command) {
      capture.set({
        allowConflict: booleanOption(this, "allowConflict"),
        brief: booleanOption(this, "brief"),
        claim: booleanOption(this, "claim"),
        command: "next",
        leaseTtlMinutes: optionalLeaseTtl(this),
        skipAfterReopens: reopenLimitSchema
          .optional()
          .parse(optionalString(this, "skipAfterReopens")),
      });
    });

  program
    .command("accept")
    .description("claim a quest")
    .argument("<id>")
    .option("--as <owner>")
    .option("--force", "accept despite a mismatched quest guild")
    .option("--lease <minutes>", "set this claim's lease length in minutes")
    .action(function (this: Command, id: string) {
      capture.set({
        command: "accept",
        force: booleanOption(this, "force"),
        id: idArgument(id),
        leaseTtlMinutes: optionalLeaseTtl(this),
        owner: optionalString(this, "as"),
      });
    });

  program
    .command("touch")
    .description("renew the lease on an accepted quest")
    .argument("<id>")
    .option("--as <owner>")
    .option("--lease <minutes>", "set this touch's lease length in minutes")
    .action(function (this: Command, id: string) {
      capture.set({
        command: "touch",
        id: idArgument(id),
        leaseTtlMinutes: optionalLeaseTtl(this),
        owner: optionalString(this, "as"),
      });
    });

  program
    .command("abandon")
    .description("release a claimed quest")
    .argument("<id>")
    .option("--as <owner>")
    .action(function (this: Command, id: string) {
      capture.set({ command: "abandon", id: idArgument(id), owner: optionalString(this, "as") });
    });

  program
    .command("verdict")
    .description("record a bug triage verdict")
    .argument("<id>")
    .addArgument(withCompletionChoices(new Argument("<verdict>"), verdictCompletionChoices))
    .option("--as <owner>")
    .option("--notes <text>")
    .option("--retest")
    .action(function (this: Command, id: string, verdict: string) {
      capture.set({
        command: "verdict",
        id: idArgument(id),
        notes: optionalText(this, "notes"),
        owner: optionalString(this, "as"),
        retest: booleanOption(this, "retest"),
        verdict: nonEmptyOptionSchema.parse(verdict),
      });
    });

  program
    .command("turnin")
    .description("submit a quest for verification")
    .argument("<id>")
    .option("--as <owner>")
    .option("--actual-files <path...>", "record files changed by the fix")
    .option("--pr <number-or-url>")
    .option("--summary <text>", "record what changed and how it was verified")
    .option("--evidence <path...>", "attach fix evidence", appendOption, [])
    .option("--json <source>", "read the command input as JSON from stdin (use -)")
    .action(function (this: Command, id: string) {
      const jsonSource = requireJsonSource(this.getOptionValue("json"));
      if (
        jsonSource !== undefined &&
        ["as", "actualFiles", "pr", "summary", "evidence"].some((name) => hasCliOption(this, name))
      ) {
        throw new LifecycleCliUsageError("turnin --json - cannot be combined with turnin flags");
      }
      capture.set({
        command: "turnin",
        actualFiles: stringList(this, "actualFiles"),
        evidence: stringList(this, "evidence"),
        id: idArgument(id),
        jsonSource,
        owner: optionalString(this, "as"),
        pr: optionalString(this, "pr"),
        summary: optionalString(this, "summary"),
      });
    });

  program
    .command("complete")
    .description("mark verification complete")
    .argument("<id>")
    .option("--as <owner>")
    .option("--evidence <path...>", "attach verification evidence", appendOption, [])
    .action(function (this: Command, id: string) {
      capture.set({
        command: "complete",
        evidence: stringList(this, "evidence"),
        id: idArgument(id),
        owner: optionalString(this, "as"),
      });
    });

  program
    .command("cancel")
    .description("cancel a quest without changing the status vocabulary")
    .argument("<id>")
    .option("--as <owner>")
    .requiredOption("--reason <text>")
    .action(function (this: Command, id: string) {
      capture.set({
        command: "cancel",
        id: idArgument(id),
        owner: optionalString(this, "as"),
        reason: optionalString(this, "reason"),
      });
    });

  program
    .command("reopen")
    .description("forward-correct a failed or terminal quest")
    .argument("<id>")
    .option("--as <owner>")
    .requiredOption("--notes <text>")
    .action(function (this: Command, id: string) {
      capture.set({
        command: "reopen",
        id: idArgument(id),
        notes: optionalString(this, "notes"),
        owner: optionalString(this, "as"),
      });
    });

  program
    .command("update")
    .description("edit quest fields or attach evidence")
    .argument("<id>")
    .option("--as <owner>")
    .option("--title <title>")
    .option("--area <area>")
    .option("--priority <priority>")
    .option("--description, --desc <text>", "replace the quest description")
    .option("--guild <guild>", "restrict the quest to an agent guild")
    .option("--clear-guild", "return the quest to the shared pool")
    .option("--notes <text>")
    .option("--predicted-files <path...>", "replace files the quest is likely to change")
    .option("--add-evidence <path...>", "attach investigation evidence", appendOption, [])
    .option("--json <source>", "read the command input as JSON from stdin (use -)")
    .action(function (this: Command, id: string) {
      const jsonSource = requireJsonSource(this.getOptionValue("json"));
      if (
        jsonSource !== undefined &&
        [
          "as",
          "title",
          "area",
          "priority",
          "desc",
          "guild",
          "clearGuild",
          "notes",
          "predictedFiles",
          "addEvidence",
        ].some((name) => hasCliOption(this, name))
      ) {
        throw new LifecycleCliUsageError("update --json - cannot be combined with update flags");
      }
      const priority = this.getOptionValue("priority");
      capture.set({
        command: "update",
        addEvidence: stringList(this, "addEvidence"),
        area: optionalString(this, "area"),
        clearGuild: booleanOption(this, "clearGuild"),
        description: optionalText(this, "desc"),
        guild: optionalString(this, "guild"),
        id: idArgument(id),
        jsonSource,
        notes: optionalText(this, "notes"),
        owner: optionalString(this, "as"),
        predictedFiles: optionalStringList(this, "predictedFiles"),
        priority: priority === undefined ? undefined : prioritySchema.parse(priority),
        title: optionalString(this, "title"),
      });
    });

  program
    .command("signoff")
    .description("record QA sign-off on completed quests")
    .argument("<ids...>")
    .option("--notes <text>", "record the QA notes")
    .option("--evidence <path...>", "attach sign-off evidence", appendOption, [])
    .action(function (this: Command, ids: readonly string[]) {
      capture.set({
        command: "signoff",
        evidence: stringList(this, "evidence"),
        ids: ids.map(idArgument),
        notes: optionalText(this, "notes"),
      });
    });
}

function requireIdentity(identity: string | undefined): string {
  if (identity === undefined) {
    throw new LifecycleCliUsageError(
      "identity is not configured; set identity in config or pass --as where supported",
    );
  }
  return identity;
}

function parseVerdict(value: string): { duplicateOf: number | null; verdict: Verdict } {
  if (value.startsWith("duplicate-of:")) {
    const duplicateOf = displayIdSchema.safeParse(value.slice("duplicate-of:".length));
    if (!duplicateOf.success) {
      throw new LifecycleCliUsageError(`invalid duplicate verdict: ${value}`);
    }
    return {
      duplicateOf: duplicateOf.data,
      verdict: "duplicate",
    };
  }
  if (value === "duplicate") {
    throw new LifecycleCliUsageError("duplicate verdict must be duplicate-of:<id>");
  }
  const verdict = verdictSchema.safeParse(value);
  if (!verdict.success) {
    throw new LifecycleCliUsageError(
      `invalid verdict ${value}; expected ${verdictSchema.options.join(", ")}, or duplicate-of:<id>`,
    );
  }
  return { duplicateOf: null, verdict: verdict.data };
}

function requireAllowedArea(config: Config, repo: string, area: string | null): void {
  if (area === null) {
    return;
  }
  const allowed = config.areas[repo];
  if (allowed !== undefined && !allowed.includes(area)) {
    throw new LifecycleCliUsageError(
      `area ${area} is not allowed for ${repo}; expected one of: ${allowed.join(", ")}`,
    );
  }
}

async function resolveAddInput(
  request: AddCliRequest,
  options: ExecuteLifecycleCliOptions,
): Promise<{ duplicateOf: number | null; input: NewQuest }> {
  if (options.scope.repo === null) {
    throw new LifecycleCliUsageError(
      "add requires a repository scope; use --repo or run in a repo",
    );
  }
  const interactive = request.title === undefined;
  if (interactive && !options.isTty) {
    throw new LifecycleCliUsageError("add title is required when stdin is not a TTY");
  }

  const prompted = await resolveAddPrompts(request, options, interactive);
  const parsedKind = questKindSchema.safeParse(prompted.kind);
  if (!parsedKind.success) {
    throw new LifecycleCliUsageError(
      `invalid kind ${prompted.kind}; expected ${questKindSchema.options.join(" or ")}`,
    );
  }
  const kind = parsedKind.data;
  const parsedVerdict = request.verdict === undefined ? null : parseVerdict(request.verdict);
  const status =
    request.status === undefined
      ? parsedVerdict === null
        ? initialStatusForKind(kind)
        : statusForVerdict(parsedVerdict.verdict)
      : questStatusSchema.parse(request.status);
  const actor = requireIdentity(options.identity);

  requireAllowedArea(options.config, options.scope.repo, prompted.area);
  return {
    duplicateOf: parsedVerdict?.duplicateOf ?? null,
    input: {
      repo: options.scope.repo,
      area: prompted.area,
      kind,
      title: prompted.title,
      description: prompted.description,
      opened_by: actor,
      guild: request.guild ?? null,
      assignee:
        status === "accepted" || status === "turned_in" || status === "complete" ? actor : null,
      status,
      verdict: parsedVerdict?.verdict ?? null,
      verdict_notes: null,
      priority: 2,
      pr: null,
      predicted_files: [...request.predictedFiles],
      reopen_count: 0,
      backfill: request.status !== undefined || request.verdict !== undefined,
      session_guild: options.config.guild ?? null,
    },
  };
}

async function readJsonInput<T>(
  source: string | undefined,
  schema: z.ZodType<T>,
  readStdin: (() => Promise<string>) | undefined,
): Promise<T | undefined> {
  if (source === undefined) {
    return undefined;
  }
  if (readStdin === undefined) {
    throw new LifecycleCliUsageError(
      "JSON stdin is unavailable; provide input through quest's stdin",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readStdin());
  } catch {
    throw new LifecycleCliUsageError(
      "invalid JSON on stdin; provide one JSON object followed by EOF",
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new LifecycleCliUsageError(
      `invalid JSON input: ${result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

async function resolveJsonAddRequest(
  request: AddCliRequest,
  readStdin: (() => Promise<string>) | undefined,
): Promise<AddCliRequest> {
  const input = await readJsonInput(request.jsonSource, addJsonInputSchema, readStdin);
  if (input === undefined) {
    return request;
  }
  return {
    command: "add",
    area: input.area,
    description: input.description,
    evidence: input.evidence ?? [],
    force: input.force ?? false,
    guild: input.guild,
    jsonSource: undefined,
    kind: input.kind ?? "task",
    predictedFiles: input.predicted_files ?? [],
    status: input.status,
    title: input.title,
    verdict: input.verdict,
  };
}

async function resolveJsonUpdateRequest(
  request: UpdateCliRequest,
  readStdin: (() => Promise<string>) | undefined,
): Promise<UpdateCliRequest> {
  const input = await readJsonInput(request.jsonSource, updateJsonInputSchema, readStdin);
  if (input === undefined) {
    return request;
  }
  return {
    command: "update",
    addEvidence: input.add_evidence ?? [],
    area: input.area,
    clearGuild: input.clear_guild ?? false,
    description: input.description,
    guild: input.guild,
    id: request.id,
    jsonSource: undefined,
    notes: input.notes,
    owner: undefined,
    predictedFiles: input.predicted_files,
    priority: input.priority,
    title: input.title,
  };
}

async function resolveJsonTurnInRequest(
  request: TurnInCliRequest,
  readStdin: (() => Promise<string>) | undefined,
): Promise<TurnInCliRequest> {
  const input = await readJsonInput(request.jsonSource, turnInJsonInputSchema, readStdin);
  if (input === undefined) {
    return request;
  }
  return {
    actualFiles: input.actual_files ?? [],
    command: "turnin",
    evidence: input.evidence ?? [],
    id: request.id,
    jsonSource: undefined,
    owner: undefined,
    pr: input.pr,
    summary: input.summary,
  };
}

async function resolveAddPrompts(
  request: AddCliRequest,
  options: ExecuteLifecycleCliOptions,
  interactive: boolean,
): Promise<{ area: string | null; description: string; kind: string; title: string }> {
  const parsedTitle = nonEmptyOptionSchema.safeParse(
    request.title ?? (await options.prompter.ask("Title: ")),
  );
  if (!parsedTitle.success) {
    throw new LifecycleCliUsageError("add title must not be empty");
  }
  const title = parsedTitle.data;
  let kind = request.kind ?? "task";
  if (interactive && request.kind === undefined) {
    kind = (await options.prompter.ask("Kind (bug/task) [task]: ")).trim() || "task";
  }

  let promptedArea = request.area;
  if (interactive && request.area === undefined) {
    promptedArea = (await options.prompter.ask("Area (optional): ")).trim();
  }
  const area = promptedArea === undefined || promptedArea === "" ? null : promptedArea;
  const description =
    request.description ??
    (interactive ? await options.prompter.ask("Description (optional): ") : "");
  return { area, description, kind, title };
}

function writeWarnings(output: CliOutputBoundary, warnings: readonly string[]): void {
  for (const warning of warnings) {
    output.write(`warning: ${warning}\n`);
  }
}

async function writeMutationResult(
  options: ExecuteLifecycleCliOptions,
  command: LifecycleCliRequest["command"],
  result: {
    changed: boolean;
    evidence: readonly Evidence[];
    forceRequired?: boolean;
    lease_expires_at?: string | null;
    quest: Quest;
    warnings: readonly string[];
  },
  humanMessage: string,
  exitCode: ExitCode = EXIT_SUCCESS,
): Promise<ExitCode> {
  if (options.format === "json") {
    const generatedAt = await options.ports.clock.now();
    const warnings = [...options.identityWarnings, ...result.warnings];
    const report =
      command === "accept"
        ? buildQuestReport(acceptMutationDataSchema, {
            command,
            generated_at: generatedAt,
            filters: { repo: options.scope.repo },
            warnings,
            data: {
              changed: result.changed,
              evidence: [...result.evidence],
              lease_expires_at: result.lease_expires_at ?? result.quest.lease_expires_at,
              quest: result.quest,
            },
          })
        : buildQuestReport(mutationDataSchema, {
            command,
            generated_at: generatedAt,
            filters: { repo: options.scope.repo },
            warnings,
            data: {
              changed: result.changed,
              evidence: [...result.evidence],
              quest: result.quest,
            },
          });
    options.output.write(formatQuestReport(report));
  } else {
    writeWarnings(options.output, [...options.identityWarnings, ...result.warnings]);
    if (result.forceRequired !== true) {
      options.output.write(`${humanMessage}\n`);
    }
  }
  return exitCode;
}

function attachmentRequest(
  actor: string,
  paths: readonly string[],
  stage: "report" | "investigation" | "fix" | "verify" | "signoff",
  workingDirectory: string,
  sessionGuild: string | null,
) {
  return { actor, paths, sessionGuild, stage, workingDirectory };
}

async function executeAdd(options: ExecuteLifecycleCliOptions): Promise<ExitCode> {
  if (options.request.command !== "add") {
    throw new Error("executeAdd received a non-add request");
  }
  const request = await resolveJsonAddRequest(options.request, options.readStdin);
  const resolved = await resolveAddInput(request, options);
  const actor = resolved.input.opened_by;
  const result = await addLifecycleQuest(options.ports, resolved.input, {
    duplicateOf: resolved.duplicateOf,
    evidence: attachmentRequest(
      actor,
      request.evidence,
      "report",
      options.workingDirectory,
      options.config.guild ?? null,
    ),
    force: request.force,
    sessionGuild: options.config.guild ?? null,
  });

  if (options.format === "json") {
    const report = buildQuestReport(addDataSchema, {
      command: "add",
      generated_at: await options.ports.clock.now(),
      filters: { repo: options.scope.repo },
      warnings: [...options.identityWarnings, ...result.warnings],
      data: {
        candidates: [...result.candidates],
        evidence: [...result.evidence],
        outcome: result.outcome,
        quest: result.quest,
      },
    });
    options.output.write(formatQuestReport(report));
  } else {
    writeWarnings(options.output, [...options.identityWarnings, ...result.warnings]);
    if (result.quest !== null) {
      options.output.write(`quest ${result.quest.id} added: ${result.quest.title}\n`);
    } else {
      options.output.write("quest not added; use --force to override duplicate candidates\n");
    }
  }
  return result.outcome === "duplicates" ? EXIT_DOMAIN_ERROR : EXIT_SUCCESS;
}

function requireBriefClaim(request: NextCliRequest): void {
  if (request.brief && !request.claim) {
    throw new LifecycleCliUsageError(
      "--brief requires --claim; run `quest next --claim --brief` to claim work with its context package",
    );
  }
  if (request.allowConflict && !request.claim) {
    throw new LifecycleCliUsageError(
      "--allow-conflict requires --claim; run `quest next --claim --allow-conflict` to claim work with the override",
    );
  }
  if (request.leaseTtlMinutes !== undefined && !request.claim) {
    throw new LifecycleCliUsageError(
      "--lease requires --claim; run `quest next --claim --lease <minutes>` to claim work with a custom lease",
    );
  }
}

function laneConflictDescription(conflict: NextLaneConflict): string {
  if (conflict.kind === "shared_files") {
    return `quest ${conflict.questId} overlaps in-flight quest ${conflict.inFlightQuestId}: ${conflict.files.join(", ")}`;
  }
  return `quest ${conflict.questId} shares area ${conflict.area ?? "<none>"} with in-flight quest ${conflict.inFlightQuestId}`;
}

function laneConflictPrompt(conflicts: readonly NextLaneConflict[]): string {
  return `Lane conflict: ${conflicts.map(laneConflictDescription).join("; ")}. Claim anyway? [y/N] `;
}

function compileNextBrief(
  request: NextCliRequest,
  result: NextQuestResult,
): { readonly brief: QuestBrief | null | undefined; readonly result: NextQuestResult } {
  if (!request.brief) {
    return { brief: undefined, result };
  }
  if (!result.claimed || result.quest === null) {
    return { brief: null, result };
  }
  if (result.brief === undefined || result.brief === null) {
    throw new LifecycleCommandError(
      `quest ${result.quest.id} was accepted without a briefing package; retry the claim with a store that supports atomic briefing`,
    );
  }
  return { brief: result.brief, result };
}

async function writeNextJson(
  options: ExecuteLifecycleCliOptions,
  result: NextQuestResult,
  brief: QuestBrief | null | undefined,
): Promise<void> {
  const report =
    brief === undefined
      ? buildQuestReport(nextDataSchema, {
          command: "next",
          generated_at: await options.ports.clock.now(),
          filters: { repo: options.scope.repo },
          warnings: [...options.identityWarnings, ...result.warnings],
          data: { claimed: result.claimed, quest: result.quest },
        })
      : buildQuestReport(nextBriefDataSchema, {
          command: "next",
          generated_at: await options.ports.clock.now(),
          filters: { repo: options.scope.repo },
          warnings: [...options.identityWarnings, ...result.warnings],
          data: {
            brief: brief === null ? null : serializeQuestBrief(brief, undefined),
            claimed: result.claimed,
            quest: result.quest,
          },
        });
  options.output.write(formatQuestReport(report));
}

function writeNextHuman(
  options: ExecuteLifecycleCliOptions,
  result: NextQuestResult,
  owner: string | null,
  brief: QuestBrief | null | undefined,
): void {
  writeWarnings(options.output, [...options.identityWarnings, ...result.warnings]);
  if (result.quest === null) {
    options.output.write("no available quest\n");
    return;
  }
  if (!result.claimed) {
    options.output.write(`quest ${result.quest.id}: ${result.quest.title}\n`);
    return;
  }
  const receipt = `quest ${result.quest.id} accepted by ${owner}: ${result.quest.title}`;
  options.output.write(
    brief === null || brief === undefined
      ? `${receipt}\n`
      : `${receipt}\n\n${renderQuestBriefMarkdown({ brief, materialized: undefined })}`,
  );
}

async function executeNext(options: ExecuteLifecycleCliOptions): Promise<ExitCode> {
  const request = options.request;
  if (request.command !== "next") {
    throw new Error("executeNext received a non-next request");
  }
  requireBriefClaim(request);
  const owner = request.claim ? requireIdentity(options.identity) : null;
  const sessionAttribution = sessionAttributionFromEnvironment(options.environment);
  const now = await options.ports.clock.now();
  const result = await getNextQuest(
    options.ports.questStore,
    options.scope,
    owner,
    undefined,
    options.config.guild ?? null,
    request.skipAfterReopens,
    request.brief,
    sessionAttribution,
    {
      allowConflict: request.allowConflict,
      now,
      ...(request.leaseTtlMinutes === undefined
        ? {}
        : { leaseTtlMinutes: request.leaseTtlMinutes }),
      ...(options.isTty && !request.allowConflict
        ? {
            resolveLaneConflict: async (conflicts: readonly NextLaneConflict[]) => {
              const answer = await options.prompter.ask(laneConflictPrompt(conflicts));
              return /^(?:y|yes)$/iu.test(answer.trim());
            },
          }
        : {}),
    },
  );
  const compiled = compileNextBrief(request, result);

  if (options.format === "json") {
    await writeNextJson(options, compiled.result, compiled.brief);
  } else {
    writeNextHuman(options, compiled.result, owner, compiled.brief);
  }
  return EXIT_SUCCESS;
}

function verdictTransition(
  request: VerdictCliRequest,
  actor: string,
  sessionGuild: string | null,
  sessionAttribution: SessionAttribution,
): Extract<QuestTransition, { action: "verdict" }> {
  const parsed = parseVerdict(request.verdict);
  if (request.retest && parsed.verdict !== "not-reproduced") {
    throw new LifecycleCliUsageError("--retest is only valid with not-reproduced");
  }
  return {
    action: "verdict",
    actor,
    ...sessionAttribution,
    session_guild: sessionGuild,
    verdict: parsed.verdict,
    notes: request.notes ?? null,
    retest: request.retest,
    duplicate_of: parsed.duplicateOf,
  };
}

function completeTransition(
  actor: string,
  sessionGuild: string | null,
  sessionAttribution: SessionAttribution,
): Extract<QuestTransition, { action: "complete" }> {
  return { action: "complete", actor, ...sessionAttribution, session_guild: sessionGuild };
}

function updateTransition(
  request: UpdateCliRequest,
  actor: string,
  config: Config,
  scope: QuestScope,
  sessionAttribution: SessionAttribution,
): QuestTransition | undefined {
  if (request.clearGuild && request.guild !== undefined) {
    throw new LifecycleCliUsageError("update cannot combine --guild and --clear-guild");
  }
  if (scope.repo !== null && request.area !== undefined) {
    requireAllowedArea(config, scope.repo, request.area);
  }
  const guildChange = request.clearGuild
    ? { guild: null }
    : request.guild === undefined
      ? {}
      : { guild: request.guild };
  const changes = {
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.area === undefined ? {} : { area: request.area }),
    ...(request.priority === undefined ? {} : { priority: request.priority }),
    ...guildChange,
    ...(request.notes === undefined ? {} : { verdict_notes: request.notes }),
    ...(request.predictedFiles === undefined
      ? {}
      : { predicted_files: [...request.predictedFiles] }),
  };
  if (Object.keys(changes).length === 0) {
    return undefined;
  }
  return {
    action: "update",
    actor,
    ...sessionAttribution,
    session_guild: config.guild ?? null,
    changes,
  };
}

async function executeTurnIn(
  options: ExecuteLifecycleCliOptions,
  sessionAttribution: SessionAttribution,
): Promise<ExitCode> {
  if (options.request.command !== "turnin") {
    throw new Error("executeTurnIn received a non-turnin request");
  }
  const request = await resolveJsonTurnInRequest(options.request, options.readStdin);
  const actor = requireIdentity(options.identity);
  const mutationActor = request.owner === undefined ? actor : request.owner;
  const sessionGuild = options.config.guild ?? null;
  const result = await transitionLifecycleQuest(
    options.ports,
    options.scope,
    request.id,
    {
      action: "turnin",
      actor: mutationActor,
      ...(request.actualFiles.length === 0 ? {} : { actual_files: [...request.actualFiles] }),
      pr: request.pr ?? null,
      ...sessionAttribution,
      session_guild: sessionGuild,
      ...(request.summary === undefined ? {} : { summary: request.summary }),
    },
    attachmentRequest(
      mutationActor,
      request.evidence,
      "fix",
      options.workingDirectory,
      sessionGuild,
    ),
    {},
  );
  return writeMutationResult(options, request.command, result, `quest ${request.id} turned in`);
}

async function writeSignoffResult(
  options: ExecuteLifecycleCliOptions,
  result: LifecycleSignoffBatchResult,
): Promise<ExitCode> {
  const warnings = [...options.identityWarnings, ...result.warnings];
  if (options.format === "json") {
    const report = buildQuestReport(signoffDataSchema, {
      command: "signoff",
      generated_at: await options.ports.clock.now(),
      filters: { repo: options.scope.repo },
      warnings,
      data: {
        changed: result.changed,
        evidence: [...result.evidence],
        quests: result.quests.map((quest) => ({
          changed: quest.changed,
          evidence: [...quest.evidence],
          quest: quest.quest,
          warnings: [...quest.warnings],
        })),
      },
    });
    options.output.write(formatQuestReport(report));
    return EXIT_SUCCESS;
  }

  writeWarnings(options.output, warnings);
  for (const quest of result.quests) {
    options.output.write(`quest ${quest.quest.id} signed off\n`);
  }
  return EXIT_SUCCESS;
}

async function executeSignoff(
  options: ExecuteLifecycleCliOptions,
  sessionAttribution: SessionAttribution,
): Promise<ExitCode> {
  if (options.request.command !== "signoff") {
    throw new Error("executeSignoff received a non-signoff request");
  }
  const actor = requireIdentity(options.identity);
  const sessionGuild = options.config.guild ?? null;
  const result = await signoffLifecycleQuests(
    options.ports,
    options.scope,
    options.request.ids,
    {
      action: "signoff",
      actor,
      ...sessionAttribution,
      session_guild: sessionGuild,
      notes: options.request.notes ?? null,
    },
    attachmentRequest(
      actor,
      options.request.evidence,
      "signoff",
      options.workingDirectory,
      sessionGuild,
    ),
  );
  return writeSignoffResult(options, result);
}

export async function executeLifecycleCli(options: ExecuteLifecycleCliOptions): Promise<ExitCode> {
  const { request } = options;
  if (request.command === "add") {
    return executeAdd(options);
  }
  if (request.command === "next") {
    return executeNext(options);
  }

  const actor = requireIdentity(options.identity);
  const mutationActor = "owner" in request && request.owner !== undefined ? request.owner : actor;
  const sessionGuild = options.config.guild ?? null;
  const sessionAttribution = sessionAttributionFromEnvironment(options.environment);
  const transitionOptions: LifecycleTransitionOptions = {
    checkPullRequestMerge:
      options.ports.checkPullRequestMerge ??
      createPullRequestMergeChecker(options.workingDirectory),
  };
  switch (request.command) {
    case "accept": {
      const result = await acceptLifecycleQuest(
        options.ports.questStore,
        options.scope,
        request.id,
        mutationActor,
        {
          ...acceptLeaseOptions(request),
          mode: request.force ? "force" : "normal",
          sessionAttribution,
          sessionGuild,
        },
      );
      return writeMutationResult(
        options,
        request.command,
        result,
        `quest ${request.id} accepted by ${mutationActor}`,
        result.forceRequired === true ? EXIT_DOMAIN_ERROR : EXIT_SUCCESS,
      );
    }
    case "touch": {
      const result = await touchLifecycleQuest(
        options.ports.questStore,
        options.scope,
        request.id,
        mutationActor,
        sessionGuild,
        sessionAttribution,
        request.leaseTtlMinutes,
      );
      return writeMutationResult(options, request.command, result, `quest ${request.id} touched`);
    }
    case "abandon": {
      const result = await transitionLifecycleQuest(
        options.ports,
        options.scope,
        request.id,
        {
          action: "abandon",
          actor: mutationActor,
          ...sessionAttribution,
          session_guild: sessionGuild,
        },
        attachmentRequest(
          mutationActor,
          [],
          "investigation",
          options.workingDirectory,
          sessionGuild,
        ),
        transitionOptions,
      );
      return writeMutationResult(options, request.command, result, `quest ${request.id} abandoned`);
    }
    case "verdict": {
      const transition = verdictTransition(
        request,
        mutationActor,
        sessionGuild,
        sessionAttribution,
      );
      const result = await transitionLifecycleQuest(
        options.ports,
        options.scope,
        request.id,
        transition,
        attachmentRequest(
          mutationActor,
          [],
          "investigation",
          options.workingDirectory,
          sessionGuild,
        ),
        transitionOptions,
      );
      return writeMutationResult(
        options,
        request.command,
        result,
        `quest ${request.id} verdict: ${transition.verdict}`,
      );
    }
    case "turnin": {
      return executeTurnIn(options, sessionAttribution);
    }
    case "signoff": {
      return executeSignoff(options, sessionAttribution);
    }
    case "complete": {
      const result = await transitionLifecycleQuest(
        options.ports,
        options.scope,
        request.id,
        completeTransition(mutationActor, sessionGuild, sessionAttribution),
        attachmentRequest(
          mutationActor,
          request.evidence,
          "verify",
          options.workingDirectory,
          sessionGuild,
        ),
        transitionOptions,
      );
      return writeMutationResult(
        options,
        request.command,
        result,
        `quest ${request.id} complete`,
        EXIT_SUCCESS,
      );
    }
    case "cancel": {
      const reason = nonEmptyOptionSchema.parse(request.reason);
      const result = await transitionLifecycleQuest(
        options.ports,
        options.scope,
        request.id,
        {
          action: "cancel",
          actor: mutationActor,
          reason,
          ...sessionAttribution,
          session_guild: sessionGuild,
        },
        attachmentRequest(
          mutationActor,
          [],
          "investigation",
          options.workingDirectory,
          sessionGuild,
        ),
        transitionOptions,
      );
      return writeMutationResult(options, request.command, result, `quest ${request.id} canceled`);
    }
    case "reopen": {
      const notes = nonEmptyOptionSchema.parse(request.notes);
      const result = await transitionLifecycleQuest(
        options.ports,
        options.scope,
        request.id,
        {
          action: "reopen",
          actor: mutationActor,
          notes,
          ...sessionAttribution,
          session_guild: sessionGuild,
        },
        attachmentRequest(mutationActor, [], "verify", options.workingDirectory, sessionGuild),
        transitionOptions,
      );
      return writeMutationResult(options, request.command, result, `quest ${request.id} reopened`);
    }
    case "update": {
      const updateRequest = await resolveJsonUpdateRequest(request, options.readStdin);
      const transition = updateTransition(
        updateRequest,
        mutationActor,
        options.config,
        options.scope,
        sessionAttribution,
      );
      if (transition === undefined && updateRequest.addEvidence.length === 0) {
        throw new LifecycleCliUsageError(
          "update requires at least one field change or --add-evidence",
        );
      }
      const result = await transitionLifecycleQuest(
        options.ports,
        options.scope,
        request.id,
        transition,
        attachmentRequest(
          mutationActor,
          updateRequest.addEvidence,
          "investigation",
          options.workingDirectory,
          sessionGuild,
        ),
        transitionOptions,
      );
      return writeMutationResult(options, request.command, result, `quest ${request.id} updated`);
    }
  }
}

export function isLifecycleCommandError(error: unknown): error is LifecycleCommandError {
  return error instanceof LifecycleCommandError;
}

export function isLifecycleCliRequest(
  request: LifecycleCliRequest | { readonly command: string },
): request is LifecycleCliRequest {
  switch (request.command) {
    case "add":
    case "next":
    case "accept":
    case "touch":
    case "abandon":
    case "verdict":
    case "turnin":
    case "complete":
    case "cancel":
    case "reopen":
    case "update":
    case "signoff":
      return true;
    default:
      return false;
  }
}
