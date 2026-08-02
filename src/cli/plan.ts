import type { Command } from "commander";
import { z } from "zod";

import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatHumanTable,
  formatQuestReport,
} from "../output";
import { type QuestScope, questSchema } from "../schema";
import { getQuestPlan, type PlanLaneCluster, planComputedStateValues } from "../services";
import type { Clock, QuestStore } from "../store";
import type { CliFormat } from "./scope";

const planComputedStateSchema = z.enum(planComputedStateValues);

const planQuestSchema = questSchema.extend({
  blockers: z.array(z.int().positive()),
  blocker_paths: z.array(z.array(z.int().positive())),
  chain_depth: z.int().nonnegative(),
  computed_state: planComputedStateSchema,
  root_blockers: z.array(z.int().positive()),
});

const laneClusterSchema = z.strictObject({
  area: z.string().nullable(),
  files: z.array(z.string()),
  heuristic: z.boolean(),
  kind: z.enum(["same_area", "shared_files"]),
  quest_ids: z.array(z.int().positive()).length(2),
});

export const planDataSchema = z.strictObject({
  lane_clusters: z.array(laneClusterSchema),
  quests: z.array(planQuestSchema),
});

export interface PlanCliRequest {
  readonly command: "plan";
}

export interface PlanRequestCapture {
  set(request: PlanCliRequest): void;
}

export interface ExecutePlanCliOptions {
  readonly clock: Clock;
  readonly format: CliFormat;
  readonly output: CliOutputBoundary;
  readonly ports: { readonly questStore: QuestStore };
  readonly request: PlanCliRequest;
  readonly scope: QuestScope;
}

function stateLabel(state: z.infer<typeof planComputedStateSchema>): string {
  return state === "in_flight" ? "in-flight" : state;
}

function laneLabel(questId: number, clusters: readonly PlanLaneCluster[]): string {
  return clusters
    .filter((cluster) => cluster.quest_ids.includes(questId))
    .map((cluster) => {
      const peer = cluster.quest_ids.find((id) => id !== questId);
      const peerLabel = peer === undefined ? "" : ` with ${peer}`;
      if (cluster.kind === "shared_files") {
        return `shared files${peerLabel}: ${cluster.files.join(", ")}`;
      }
      return `same area${peerLabel}: ${cluster.area ?? "<none>"} (heuristic)`;
    })
    .join("; ");
}

function renderPlan(plan: z.infer<typeof planDataSchema>, includeRepo: boolean): string {
  return formatHumanTable({
    columns: [
      { header: "ID", align: "right" },
      ...(includeRepo ? [{ header: "REPO" }] : []),
      { header: "STATE" },
      { header: "DEPTH", align: "right" },
      { header: "BLOCKERS" },
      { header: "ROOTS" },
      { header: "LANE" },
      { header: "TITLE" },
    ],
    rows: plan.quests.map((quest) => [
      quest.id,
      ...(includeRepo ? [quest.repo] : []),
      stateLabel(quest.computed_state),
      quest.chain_depth,
      quest.blockers.join(", "),
      quest.root_blockers.join(", "),
      laneLabel(quest.id, plan.lane_clusters),
      quest.title,
    ]),
  });
}

export function registerPlanCommand(program: Command, capture: PlanRequestCapture): void {
  program
    .command("plan")
    .description("show the computed dispatch plan for agents")
    .action(() => {
      capture.set({ command: "plan" });
    });
}

export async function executePlanCli(options: ExecutePlanCliOptions): Promise<ExitCode> {
  if (options.request.command !== "plan") {
    throw new Error("executePlanCli received a non-plan request");
  }
  const generatedAt = await options.clock.now();
  const plan = planDataSchema.parse(
    await getQuestPlan(options.ports.questStore, options.scope, generatedAt),
  );
  if (options.format === "json") {
    const report = buildQuestReport(planDataSchema, {
      command: "plan",
      generated_at: generatedAt,
      filters: { repo: options.scope.repo },
      warnings: [],
      data: plan,
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(`${renderPlan(plan, options.scope.repo === null)}\n`);
  }
  return EXIT_SUCCESS;
}

export function isPlanCliRequest(
  request: PlanCliRequest | { readonly command: string },
): request is PlanCliRequest {
  return request.command === "plan";
}
