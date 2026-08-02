import { z } from "zod";

import type { Event } from "../schema";
import type { ChainQuestReference, MaterializedQuestEvidence, QuestBrief } from "../services";

export interface RenderQuestBriefOptions {
  readonly brief: QuestBrief;
  readonly materialized: MaterializedQuestEvidence | undefined;
}

const turnInEventDetailSchema = z.object({
  session_effort: z.string().optional(),
  session_model: z.string().optional(),
  summary: z.string().optional(),
});

function headline(brief: QuestBrief): string {
  const quest = brief.quest;
  const identityLine = [
    quest.kind,
    quest.area === null ? "no area" : `area ${quest.area}`,
    quest.status,
    `priority ${quest.priority}`,
    quest.assignee === null ? "unclaimed" : `assigned to ${quest.assignee}`,
  ].join(" · ");
  const provenanceLine = [
    `repo ${quest.repo}`,
    `opened by ${quest.opened_by}`,
    ...(quest.reopen_count > 0 ? [`reopened ×${quest.reopen_count}`] : []),
    ...(quest.pr === null ? [] : [`pr ${quest.pr}`]),
  ].join(" · ");
  return [
    `# quest ${quest.id} — ${quest.title}`,
    "",
    identityLine,
    provenanceLine,
    `created ${quest.created_at} · updated ${quest.updated_at}`,
  ].join("\n");
}

function blockingRequires(brief: QuestBrief): readonly ChainQuestReference[] {
  return brief.chain_position.requires.filter((reference) => reference.status !== "complete");
}

const CLAIMABLE_STATUSES = new Set(["open", "ready"]);

function blockedBanner(brief: QuestBrief): readonly string[] {
  if (!CLAIMABLE_STATUSES.has(brief.quest.status)) {
    return [];
  }
  const blocking = blockingRequires(brief);
  if (blocking.length === 0) {
    return [];
  }
  const ids = blocking.map((reference) => reference.id).join(", ");
  return ["", `⛓ BLOCKED — incomplete requirements: ${ids}. Do not accept this quest yet.`];
}

function missionSection(brief: QuestBrief): readonly string[] {
  const description =
    brief.quest.description === "" ? "(no description recorded)" : brief.quest.description;
  return ["", "## Mission", "", description];
}

function verdictSection(brief: QuestBrief): readonly string[] {
  const quest = brief.quest;
  if (quest.verdict === null && quest.verdict_notes === null) {
    return [];
  }
  const verdictLine = [quest.verdict ?? "(no verdict)", quest.verdict_notes]
    .filter((part): part is string => part !== null)
    .join(" — ");
  return ["", "## Verdict", "", verdictLine];
}

function chainLine(relation: string, reference: ChainQuestReference): string {
  const blocking =
    relation === "requires" && reference.status !== "complete" ? " ← incomplete, blocks this" : "";
  return `- ${relation} ${reference.id} [${reference.status}] ${reference.title}${blocking}`;
}

function chainSection(brief: QuestBrief): readonly string[] {
  const position = brief.chain_position;
  const lines = [
    ...position.requires.map((reference) => chainLine("requires", reference)),
    ...position.required_by.map((reference) => chainLine("unlocks", reference)),
    ...position.duplicate_of.map((reference) => chainLine("duplicate of", reference)),
    ...position.duplicates.map((reference) => chainLine("duplicated by", reference)),
  ];
  if (lines.length === 0) {
    return [];
  }
  return ["", "## Chain", "", ...lines];
}

function predictedFilesSection(brief: QuestBrief): readonly string[] {
  const quest = brief.quest;
  if (quest.predicted_files.length === 0) {
    return [
      "",
      "## Predicted files",
      "",
      `(none recorded — record yours early: \`quest update ${quest.id} --predicted-files <path>...\`)`,
    ];
  }
  return ["", "## Predicted files", "", ...quest.predicted_files.map((file) => `- ${file}`)];
}

function evidenceSection(options: RenderQuestBriefOptions): readonly string[] {
  const { brief, materialized } = options;
  if (brief.evidence.length === 0) {
    return ["", "## Evidence · 0", "", "(none attached)"];
  }
  const pathsByEvidenceId = new Map(
    (materialized?.files ?? []).map((file) => [file.evidence_id, file.path]),
  );
  const lines = brief.evidence.flatMap((item) => {
    const summary = `- [${item.stage}] ${item.filename} · ${item.kind} · added by ${item.added_by} · ${item.created_at}`;
    const path = pathsByEvidenceId.get(item.id);
    return path === undefined ? [summary, `  sha256 ${item.sha256}`] : [summary, `  file ${path}`];
  });
  const hint =
    materialized === undefined
      ? ["", `(read the files: \`quest brief ${brief.quest.id} --materialize\`)`]
      : [];
  return ["", `## Evidence · ${brief.evidence.length}`, "", ...lines, ...hint];
}

function eventLine(event: Event): string {
  const detail = JSON.stringify(event.detail);
  const detailSuffix = detail === "{}" ? "" : ` · ${detail}`;
  return `- ${event.at} ${event.action} · ${event.actor}${detailSuffix}`;
}

function turnInDetails(event: Event): {
  readonly attribution: string | null;
  readonly summary: string | null;
} {
  if (event.action !== "turnin") {
    return { attribution: null, summary: null };
  }
  const parsed = turnInEventDetailSchema.safeParse(event.detail);
  if (!parsed.success) {
    return { attribution: null, summary: null };
  }
  const attribution = [parsed.data.session_model, parsed.data.session_effort]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("/");
  return {
    attribution: attribution === "" ? null : attribution,
    summary: parsed.data.summary ?? null,
  };
}

function attemptSummaryLines(summary: string | null): readonly string[] {
  return summary === null ? ["(no summary recorded)"] : summary.split(/\r?\n/);
}

function attemptLines(
  event: Event,
  details: ReturnType<typeof turnInDetails>,
  index: number,
): readonly string[] {
  const summaryLines = attemptSummaryLines(details.summary);
  const firstLine = summaryLines.at(0) ?? "";
  const attribution = details.attribution === null ? "" : ` · ${details.attribution}`;
  return [
    `- Attempt ${index + 1} · ${event.at} · ${event.actor}${attribution} — ${firstLine}`,
    ...summaryLines.slice(1).map((line) => `  ${line}`),
  ];
}

function attemptsSection(brief: QuestBrief): readonly string[] {
  const attempts = brief.events
    .filter((event) => event.action === "turnin")
    .map((event) => ({ details: turnInDetails(event), event }));
  if (attempts.length === 0) {
    return [];
  }
  return [
    "",
    `## Attempts · ${attempts.length}`,
    "",
    ...attempts.flatMap(({ details, event }, index) => attemptLines(event, details, index)),
  ];
}

function historySection(brief: QuestBrief): readonly string[] {
  if (brief.events.length === 0) {
    return [];
  }
  return [
    "",
    `## History · ${brief.events.length} events, oldest first`,
    "",
    ...brief.events.map(eventLine),
  ];
}

function workingAgreementSection(brief: QuestBrief): readonly string[] {
  const id = brief.quest.id;
  return [
    "",
    "## Working agreement",
    "",
    `- Claim before touching anything: \`quest accept ${id}\`. If this brief says BLOCKED or your guild mismatches, stop and escalate instead.`,
    `- Attach evidence as you go (\`quest update ${id} --add-evidence <path>\`); every claim in your turnin needs a receipt.`,
    `- Implementers finish at \`quest turnin ${id}\` — never \`complete\`. A verifier completes after the work is verified.`,
  ];
}

/**
 * Renders the resumable context package as agent-consumable markdown. This is
 * the handoff document (VISION pillar 2): a cold session reading only this
 * output should be able to start work without further queries.
 */
export function renderQuestBriefMarkdown(options: RenderQuestBriefOptions): string {
  return [
    headline(options.brief),
    ...blockedBanner(options.brief),
    ...missionSection(options.brief),
    ...verdictSection(options.brief),
    ...chainSection(options.brief),
    ...predictedFilesSection(options.brief),
    ...evidenceSection(options),
    ...attemptsSection(options.brief),
    ...historySection(options.brief),
    ...workingAgreementSection(options.brief),
    "",
  ].join("\n");
}
