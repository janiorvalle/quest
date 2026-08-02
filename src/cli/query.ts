import { type Command, Option } from "commander";
import { z } from "zod";

import { createEvidenceMaterializer } from "../evidence";
import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatHumanTable,
  formatQuestReport,
} from "../output";
import type { Config, Event, Quest, QuestScope, QuestStats } from "../schema";
import {
  eventActionSchema,
  eventFilterSchema,
  eventRepository,
  eventSchema,
  evidenceSchema,
  questKindSchema,
  questSchema,
  questStatsSchema,
  questStatusSchema,
  verdictSchema,
} from "../schema";
import {
  type ChainQuestReference,
  compileQuestBrief,
  type EventQuery,
  listQuestResults,
  type MaterializedQuestEvidence,
  materializeQuestEvidence,
  type QuestBrief,
  type QuestDetail,
  queryQuestEvents,
  questStats,
  showQuestDetail,
} from "../services";
import type { BlobStore, Clock, QuestStore } from "../store";
import { renderQuestBriefMarkdown } from "./brief";
import type { CliFormat } from "./scope";

const nonEmptyOptionSchema = z.string().trim().min(1);
const displayIdSchema = z.coerce.number().int().positive();
const eventCursorSchema = nonEmptyOptionSchema
  .transform((value) => Number(value))
  .pipe(z.number().int().nonnegative());

const listDataSchema = z.strictObject({
  quests: z.array(questSchema),
  total: z.int().nonnegative(),
});

const chainQuestReferenceSchema = questSchema.pick({
  assignee: true,
  id: true,
  repo: true,
  status: true,
  title: true,
});

const chainPositionSchema = z.strictObject({
  duplicate_of: z.array(chainQuestReferenceSchema),
  duplicates: z.array(chainQuestReferenceSchema),
  required_by: z.array(chainQuestReferenceSchema),
  requires: z.array(chainQuestReferenceSchema),
});

const showDataSchema = z.strictObject({
  chain_position: chainPositionSchema,
  evidence: z.array(evidenceSchema),
  materialized: z
    .strictObject({
      directory: z.string(),
      files: z.array(
        z.strictObject({
          evidence_id: z.int().positive(),
          extension: z.string(),
          filename: z.string(),
          path: z.string(),
        }),
      ),
    })
    .nullable(),
  quest: questSchema,
});

const eventsDataSchema = z.strictObject({
  events: z.array(eventSchema),
  total: z.int().nonnegative(),
});

export const briefDataSchema = showDataSchema.safeExtend({
  events: z.array(eventSchema),
});

export function serializeQuestBrief(
  brief: QuestBrief,
  materialized: MaterializedQuestEvidence | undefined,
): z.infer<typeof briefDataSchema> {
  return {
    quest: brief.quest,
    evidence: [...brief.evidence],
    events: [...brief.events],
    chain_position: {
      requires: [...brief.chain_position.requires],
      required_by: [...brief.chain_position.required_by],
      duplicate_of: [...brief.chain_position.duplicate_of],
      duplicates: [...brief.chain_position.duplicates],
    },
    materialized:
      materialized === undefined
        ? null
        : {
            directory: materialized.directory,
            files: [...materialized.files],
          },
  };
}

interface BriefCliRequest {
  readonly command: "brief";
  readonly id: number;
  readonly materialize: boolean;
}

interface ListCliRequest {
  readonly area?: string | undefined;
  readonly blocked: boolean;
  readonly command: "list";
  readonly kind?: Quest["kind"] | undefined;
  readonly mine: boolean;
  readonly status?: Quest["status"] | undefined;
  readonly unclaimed: boolean;
}

interface ShowCliRequest {
  readonly command: "show";
  readonly id: number;
  readonly materialize: boolean;
}

interface StatsCliRequest {
  readonly command: "stats";
}

interface EventsCliRequest extends EventQuery {
  readonly command: "events";
}

export type QueryCliRequest =
  | BriefCliRequest
  | EventsCliRequest
  | ListCliRequest
  | ShowCliRequest
  | StatsCliRequest;

export interface QueryRequestCapture {
  set(request: QueryCliRequest): void;
}

export interface ExecuteQueryCliOptions {
  readonly config: Config;
  readonly format: CliFormat;
  readonly identity: string | undefined;
  readonly output: CliOutputBoundary;
  readonly ports: {
    readonly blobStore: BlobStore;
    readonly clock: Clock;
    readonly questStore: QuestStore;
  };
  readonly request: QueryCliRequest;
  readonly scope: QuestScope;
}

export class QueryCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryCliUsageError";
  }
}

function optionalString(command: Command, name: string): string | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : nonEmptyOptionSchema.parse(value);
}

function booleanOption(command: Command, name: string): boolean {
  return z.boolean().parse(command.getOptionValue(name) ?? false);
}

function optionalDisplayId(command: Command, name: string): number | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : displayIdSchema.parse(value);
}

function optionalEventCursor(command: Command, name: string): number | undefined {
  const value = command.getOptionValue(name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = eventCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new QueryCliUsageError("--after-id must be a nonnegative integer");
  }
  return parsed.data;
}

export function registerQueryCommands(program: Command, capture: QueryRequestCapture): void {
  program
    .command("list")
    .description("list quests in the selected scope")
    .addOption(new Option("--status <status>").choices(questStatusSchema.options))
    .option("--area <area>")
    .addOption(new Option("--kind <kind>").choices(questKindSchema.options))
    .addOption(
      new Option("--mine", "show quests assigned to the configured identity").conflicts(
        "unclaimed",
      ),
    )
    .addOption(new Option("--unclaimed", "show unassigned quests").conflicts("mine"))
    .option("--blocked", "show quests blocked by incomplete requirements")
    .action(function (this: Command) {
      capture.set({
        command: "list",
        area: optionalString(this, "area"),
        blocked: booleanOption(this, "blocked"),
        kind: questKindSchema.optional().parse(optionalString(this, "kind")),
        mine: booleanOption(this, "mine"),
        status: questStatusSchema.optional().parse(optionalString(this, "status")),
        unclaimed: booleanOption(this, "unclaimed"),
      });
    });

  program
    .command("show")
    .description("show full quest detail")
    .argument("<id>")
    .option("--materialize", "write evidence blobs as named files")
    .action(function (this: Command, id: string) {
      capture.set({
        command: "show",
        id: displayIdSchema.parse(id),
        materialize: booleanOption(this, "materialize"),
      });
    });

  program
    .command("stats")
    .description("show per-repository quest statistics")
    .action(() => {
      capture.set({ command: "stats" });
    });

  program
    .command("brief")
    .description("compile the full context package for starting work on a quest")
    .argument("<id>")
    .option("--materialize", "write evidence blobs as named files and include their paths")
    .action(function (this: Command, id: string) {
      capture.set({
        command: "brief",
        id: displayIdSchema.parse(id),
        materialize: booleanOption(this, "materialize"),
      });
    });

  program
    .command("events")
    .description("query the append-only event log")
    .option("--after-id <id>")
    .option("--since <timestamp>")
    .option("--until <timestamp>")
    .option("--actor <actor>")
    .addOption(new Option("--action <action>").choices(eventActionSchema.options))
    .option("--area <area>")
    .option("--quest <id>")
    .action(function (this: Command) {
      const query = {
        after_id: optionalEventCursor(this, "afterId"),
        action: eventActionSchema.optional().parse(optionalString(this, "action")),
        actor: optionalString(this, "actor"),
        area: optionalString(this, "area"),
        quest: optionalDisplayId(this, "quest"),
        since: optionalString(this, "since"),
        until: optionalString(this, "until"),
      } satisfies EventQuery;
      const { quest, ...eventFilter } = query;
      const validation = eventFilterSchema.safeParse({ ...eventFilter, quest_id: quest });
      if (!validation.success) {
        throw new QueryCliUsageError(validation.error.issues[0]?.message ?? "invalid event filter");
      }
      capture.set({ command: "events", ...query });
    });
}

function requireIdentity(identity: string | undefined): string {
  if (identity === undefined) {
    throw new QueryCliUsageError(
      "identity is not configured; set identity in config before using --mine",
    );
  }
  return identity;
}

function displayArea(config: Config, quest: Quest): string | null {
  if (quest.area === null) {
    return null;
  }
  return config.labels.areas[quest.repo]?.[quest.area] ?? quest.area;
}

function displayStatus(config: Config, status: Quest["status"]): string {
  return config.labels.statuses[status] ?? status;
}

function renderQuestList(config: Config, quests: readonly Quest[], includeRepo: boolean): string {
  return formatHumanTable({
    columns: [
      { header: "ID", align: "right" },
      ...(includeRepo ? [{ header: "REPO" }] : []),
      { header: "STATUS" },
      { header: "KIND" },
      { header: "AREA" },
      { header: "PRI", align: "right" },
      { header: "ASSIGNEE" },
      { header: "TITLE" },
    ],
    rows: quests.map((quest) => [
      quest.id,
      ...(includeRepo ? [quest.repo] : []),
      displayStatus(config, quest.status),
      quest.kind,
      displayArea(config, quest),
      quest.priority,
      quest.assignee,
      quest.title,
    ]),
  });
}

function renderQuestDetail(detail: QuestDetail): string {
  const quest = detail.quest;
  const details = formatHumanTable({
    columns: [{ header: "FIELD" }, { header: "VALUE" }],
    rows: [
      ["ID", quest.id],
      ["Title", quest.title],
      ["Repo", quest.repo],
      ["Area", quest.area],
      ["Kind", quest.kind],
      ["Status", quest.status],
      ["Verdict", quest.verdict],
      ["Verdict notes", quest.verdict_notes],
      ["Priority", quest.priority],
      ["Opened by", quest.opened_by],
      ["Guild", quest.guild],
      ["Assignee", quest.assignee],
      ["PR", quest.pr],
      ["Predicted files", quest.predicted_files.join(", ")],
      ["Reopens", quest.reopen_count],
      ["Created", quest.created_at],
      ["Updated", quest.updated_at],
      ["Description", quest.description],
    ],
  });
  const evidence = formatHumanTable({
    columns: [
      { header: "ID", align: "right" },
      { header: "FILENAME" },
      { header: "KIND" },
      { header: "STAGE" },
      { header: "ADDED BY" },
      { header: "CREATED" },
      { header: "SHA256" },
    ],
    rows: detail.evidence.map((item) => [
      item.id,
      item.filename,
      item.kind,
      item.stage,
      item.added_by,
      item.created_at,
      item.sha256,
    ]),
  });
  const chainRows: { item: ChainQuestReference; relation: string }[] = [
    ...detail.chain_position.requires.map((item) => ({ item, relation: "requires" })),
    ...detail.chain_position.required_by.map((item) => ({ item, relation: "required by" })),
    ...detail.chain_position.duplicate_of.map((item) => ({ item, relation: "duplicate of" })),
    ...detail.chain_position.duplicates.map((item) => ({ item, relation: "duplicate" })),
  ];
  const chain = formatHumanTable({
    columns: [
      { header: "RELATION" },
      { header: "ID", align: "right" },
      { header: "REPO" },
      { header: "STATUS" },
      { header: "ASSIGNEE" },
      { header: "TITLE" },
    ],
    rows: chainRows.map(({ item, relation }) => [
      relation,
      item.id,
      item.repo,
      item.status,
      item.assignee,
      item.title,
    ]),
  });
  return `${details}\n\nEvidence\n${evidence}\n\nChain position\n${chain}`;
}

function renderMaterializedEvidence(
  materialized: Awaited<ReturnType<typeof materializeQuestEvidence>>,
): string {
  const files = formatHumanTable({
    columns: [{ header: "EVIDENCE ID", align: "right" }, { header: "PATH" }],
    rows: materialized.files.map((file) => [file.evidence_id, file.path]),
  });
  return `Materialized evidence\nDirectory: ${materialized.directory}\n${files}`;
}

function renderStats(config: Config, stats: QuestStats): string {
  const summary = formatHumanTable({
    columns: [
      { header: "REPO" },
      { header: "TOTAL", align: "right" },
      { header: "REOPENS", align: "right" },
    ],
    rows: stats.repos.map((repo) => [repo.repo, repo.total, repo.reopen_count]),
  });
  const status = formatHumanTable({
    columns: [{ header: "REPO" }, { header: "STATUS" }, { header: "COUNT", align: "right" }],
    rows: stats.repos.flatMap((repo) =>
      questStatusSchema.options.flatMap((name) => {
        const count = repo.status_counts[name];
        return count === undefined
          ? []
          : [[repo.repo, config.labels.statuses[name] ?? name, count]];
      }),
    ),
  });
  const verdict = formatHumanTable({
    columns: [{ header: "REPO" }, { header: "VERDICT" }, { header: "COUNT", align: "right" }],
    rows: stats.repos.flatMap((repo) =>
      verdictSchema.options.flatMap((name) => {
        const count = repo.verdict_counts[name];
        return count === undefined
          ? []
          : [[repo.repo, config.labels.verdicts[name] ?? name, count]];
      }),
    ),
  });
  const assignee = formatHumanTable({
    columns: [{ header: "REPO" }, { header: "ASSIGNEE" }, { header: "COUNT", align: "right" }],
    rows: stats.repos.flatMap((repo) =>
      Object.entries(repo.assignee_load).map(([name, count]) => [repo.repo, name, count]),
    ),
  });
  return `Summary\n${summary}\n\nStatus\n${status}\n\nVerdict\n${verdict}\n\nAssignee load\n${assignee}`;
}

function renderEvents(events: readonly Event[], includeRepo: boolean): string {
  return formatHumanTable({
    columns: [
      { header: "ID", align: "right" },
      ...(includeRepo ? [{ header: "REPO" }] : []),
      { header: "QUEST", align: "right" },
      { header: "AT" },
      { header: "ACTOR" },
      { header: "ACTION" },
      { header: "DETAIL" },
    ],
    rows: events.map((event) => [
      event.id,
      ...(includeRepo ? [eventRepository(event) ?? null] : []),
      event.quest_id,
      event.at,
      event.actor,
      event.action,
      JSON.stringify(event.detail),
    ]),
  });
}

async function executeList(options: ExecuteQueryCliOptions): Promise<ExitCode> {
  if (options.request.command !== "list") {
    throw new Error("executeList received a non-list request");
  }
  const assignee = options.request.mine
    ? requireIdentity(options.identity)
    : options.request.unclaimed
      ? null
      : undefined;
  const quests = await listQuestResults(options.ports.questStore, options.scope, {
    area: options.request.area,
    assignee,
    blocked: options.request.blocked ? true : undefined,
    kind: options.request.kind,
    status: options.request.status,
  });

  if (options.format === "json") {
    const report = buildQuestReport(listDataSchema, {
      command: "list",
      generated_at: await options.ports.clock.now(),
      filters: {
        repo: options.scope.repo,
        status: options.request.status ?? null,
        area: options.request.area ?? null,
        kind: options.request.kind ?? null,
        mine: options.request.mine,
        unclaimed: options.request.unclaimed,
        blocked: options.request.blocked,
      },
      warnings: [],
      data: { quests, total: quests.length },
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(
      `${renderQuestList(options.config, quests, options.scope.repo === null)}\n`,
    );
  }
  return EXIT_SUCCESS;
}

async function executeShow(options: ExecuteQueryCliOptions): Promise<ExitCode> {
  if (options.request.command !== "show") {
    throw new Error("executeShow received a non-show request");
  }
  const detail = await showQuestDetail(options.ports.questStore, options.scope, options.request.id);
  const materialized = options.request.materialize
    ? await materializeQuestEvidence(
        options.ports.blobStore,
        detail.evidence,
        createEvidenceMaterializer,
        detail.quest.repo,
      )
    : undefined;
  if (options.format === "json") {
    const report = buildQuestReport(showDataSchema, {
      command: "show",
      generated_at: await options.ports.clock.now(),
      filters: { repo: options.scope.repo, id: options.request.id },
      warnings: [],
      data: {
        quest: detail.quest,
        evidence: [...detail.evidence],
        chain_position: {
          requires: [...detail.chain_position.requires],
          required_by: [...detail.chain_position.required_by],
          duplicate_of: [...detail.chain_position.duplicate_of],
          duplicates: [...detail.chain_position.duplicates],
        },
        materialized:
          materialized === undefined
            ? null
            : {
                directory: materialized.directory,
                files: [...materialized.files],
              },
      },
    });
    options.output.write(formatQuestReport(report));
  } else {
    const materializedOutput =
      materialized === undefined ? "" : `\n\n${renderMaterializedEvidence(materialized)}`;
    options.output.write(`${renderQuestDetail(detail)}${materializedOutput}\n`);
  }
  return EXIT_SUCCESS;
}

async function executeStats(options: ExecuteQueryCliOptions): Promise<ExitCode> {
  const stats = await questStats(options.ports.questStore, options.scope);
  if (options.format === "json") {
    const report = buildQuestReport(questStatsSchema, {
      command: "stats",
      generated_at: await options.ports.clock.now(),
      filters: { repo: options.scope.repo },
      warnings: [],
      data: stats,
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(`${renderStats(options.config, stats)}\n`);
  }
  return EXIT_SUCCESS;
}

async function executeEvents(options: ExecuteQueryCliOptions): Promise<ExitCode> {
  if (options.request.command !== "events") {
    throw new Error("executeEvents received a non-events request");
  }
  const events = await queryQuestEvents(options.ports.questStore, options.scope, options.request);
  if (options.format === "json") {
    const report = buildQuestReport(eventsDataSchema, {
      command: "events",
      generated_at: await options.ports.clock.now(),
      filters: {
        repo: options.scope.repo,
        after_id: options.request.after_id ?? null,
        since: options.request.since ?? null,
        until: options.request.until ?? null,
        actor: options.request.actor ?? null,
        action: options.request.action ?? null,
        area: options.request.area ?? null,
        quest: options.request.quest ?? null,
      },
      warnings: [],
      data: { events, total: events.length },
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(`${renderEvents(events, options.scope.repo === null)}\n`);
  }
  return EXIT_SUCCESS;
}

async function executeBrief(options: ExecuteQueryCliOptions): Promise<ExitCode> {
  if (options.request.command !== "brief") {
    throw new Error("executeBrief received a non-brief request");
  }
  const brief = await compileQuestBrief(
    options.ports.questStore,
    options.scope,
    options.request.id,
  );
  const materialized = options.request.materialize
    ? await materializeQuestEvidence(
        options.ports.blobStore,
        brief.evidence,
        createEvidenceMaterializer,
        brief.quest.repo,
      )
    : undefined;
  if (options.format === "json") {
    const report = buildQuestReport(briefDataSchema, {
      command: "brief",
      generated_at: await options.ports.clock.now(),
      filters: { repo: options.scope.repo, id: options.request.id },
      warnings: [],
      data: serializeQuestBrief(brief, materialized),
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(renderQuestBriefMarkdown({ brief, materialized }));
  }
  return EXIT_SUCCESS;
}

export function executeQueryCli(options: ExecuteQueryCliOptions): Promise<ExitCode> {
  switch (options.request.command) {
    case "brief":
      return executeBrief(options);
    case "events":
      return executeEvents(options);
    case "list":
      return executeList(options);
    case "show":
      return executeShow(options);
    case "stats":
      return executeStats(options);
  }
}

export function isQueryCliRequest(
  request: QueryCliRequest | { readonly command: string },
): request is QueryCliRequest {
  return (
    request.command === "brief" ||
    request.command === "events" ||
    request.command === "list" ||
    request.command === "show" ||
    request.command === "stats"
  );
}
