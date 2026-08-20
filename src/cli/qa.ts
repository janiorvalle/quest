import type { Command } from "commander";
import { z } from "zod";
import {
  type QaQueue,
  type QaSession,
  type QaShell,
  qaGroupingReasonValues,
  qaShellValues,
} from "../domain/qa";
import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatHumanTable,
  formatQuestReport,
} from "../output";
import type { QuestScope } from "../schema";
import { getQaQueue } from "../services";
import type { Clock, QuestStore } from "../store";
import type { CliFormat } from "./scope";

const qaSessionSchema = z.strictObject({
  area: z.string().nullable(),
  files: z.array(z.string()),
  group: z.int().positive(),
  ids: z.array(z.int().positive()).min(1),
  oldest_at: z.string(),
  reason: z.enum(qaGroupingReasonValues),
  repo: z.string().min(1),
  signoff: z.string().min(1),
  signoff_variants: z.array(
    z.strictObject({
      command: z.string().min(1),
      shell: z.enum(qaShellValues),
    }),
  ),
  why: z.string().min(1),
});

export const qaDataSchema = z.strictObject({
  footer: z.string().min(1),
  message: z.string().nullable(),
  sessions: z.array(qaSessionSchema),
  summary: z.strictObject({
    quests: z.int().nonnegative(),
    sessions: z.int().nonnegative(),
  }),
});

export interface QaCliRequest {
  readonly command: "qa";
}

export interface QaRequestCapture {
  set(request: QaCliRequest): void;
}

export interface ExecuteQaCliOptions {
  readonly clock: Clock;
  readonly format: CliFormat;
  readonly output: CliOutputBoundary;
  readonly ports: { readonly questStore: QuestStore };
  readonly request: QaCliRequest;
  readonly shell?: QaShell;
  readonly scope: QuestScope;
  readonly scopeWarnings?: readonly string[] | undefined;
}

function areaLabel(session: QaSession): string {
  if (session.area !== null) {
    return session.area;
  }
  return session.reason === "area" ? "<none>" : "<mixed>";
}

function renderQa(queue: QaQueue): string {
  const body =
    queue.sessions.length === 0
      ? (queue.message ?? "Nothing awaiting sign-off.")
      : formatHumanTable({
          columns: [
            { header: "GROUP", align: "right" },
            { header: "IDS" },
            { header: "AREA" },
            { header: "WHY ONE SESSION" },
            { header: "COPYABLE SIGNOFF" },
          ],
          rows: queue.sessions.map((session) => [
            session.group,
            session.ids.join(" "),
            areaLabel(session),
            session.why,
            session.signoff,
          ]),
        });
  const variantRows = queue.sessions.flatMap((session) =>
    session.signoff_variants.length < 2
      ? []
      : session.signoff_variants.map((variant) => [session.group, variant.shell, variant.command]),
  );
  const variants =
    variantRows.length === 0
      ? []
      : [
          "Shell-specific sign-off commands:",
          formatHumanTable({
            columns: [{ header: "GROUP" }, { header: "SHELL" }, { header: "COPYABLE SIGNOFF" }],
            rows: variantRows,
          }),
        ];
  return [
    body,
    ...variants,
    `${queue.summary.sessions} sessions instead of ${queue.summary.quests} quests.`,
    queue.footer,
  ].join("\n");
}

export function registerQaCommand(program: Command, capture: QaRequestCapture): void {
  program
    .command("qa")
    .description("group completed unsigned quests into QA sign-off sessions")
    .action(() => {
      capture.set({ command: "qa" });
    });
}

export async function executeQaCli(options: ExecuteQaCliOptions): Promise<ExitCode> {
  if (options.request.command !== "qa") {
    throw new Error("executeQaCli received a non-QA request");
  }
  const generatedAt = await options.clock.now();
  const queue = qaDataSchema.parse(
    await getQaQueue(options.ports.questStore, options.scope, options.shell),
  );
  if (options.format === "json") {
    const report = buildQuestReport(qaDataSchema, {
      command: "qa",
      generated_at: generatedAt,
      filters: { repo: options.scope.repo },
      warnings: [...(options.scopeWarnings ?? [])],
      data: queue,
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(`${renderQa(queue)}\n`);
  }
  return EXIT_SUCCESS;
}

export function isQaCliRequest(
  request: QaCliRequest | { readonly command: string },
): request is QaCliRequest {
  return request.command === "qa";
}
