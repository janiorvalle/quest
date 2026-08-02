import { extname } from "node:path";

import { z } from "zod";

import { scoreDedupCandidate } from "../domain";
import type { EvidenceFileReader } from "../evidence";
import type {
  AcceptQuestInput,
  AcceptResult,
  Evidence,
  EvidenceKind,
  EvidenceStage,
  NewQuest,
  Quest,
  QuestDump,
  QuestScope,
  QuestTransition,
} from "../schema";
import { newQuestSchema, questTransitionSchema } from "../schema";
import type { BlobStore, QuestStore } from "../store";

const DEDUP_CANDIDATE_SCORE = 0.6;

const evidenceEventDetailSchema = z.object({
  evidence_id: z.int().positive(),
});

const turnInEventDetailSchema = z.object({
  pr: z.string().trim().min(1).nullable().optional(),
  session_effort: z.string().optional(),
  session_guild: z.string().nullable().optional(),
  session_model: z.string().optional(),
});

const newQuestReplaySchema = newQuestSchema.omit({ session_guild: true });
type NewQuestReplay = z.infer<typeof newQuestReplaySchema>;

export interface LifecycleServicePorts {
  readonly blobStore: BlobStore;
  readonly evidenceFiles: EvidenceFileReader;
  readonly questStore: QuestStore;
}

export interface EvidenceAttachmentRequest {
  readonly actor: string;
  readonly paths: readonly string[];
  readonly sessionGuild: string | null;
  readonly stage: EvidenceStage;
  readonly workingDirectory: string;
}

export interface SessionAttribution {
  readonly session_effort?: string | undefined;
  readonly session_model?: string | undefined;
}

export interface LifecycleTransitionOptions {
  readonly checkPullRequestMerge?: PullRequestMergeChecker;
}

export interface PullRequestMergeState {
  readonly state: string;
  readonly url: string;
}

export type PullRequestMergeChecker = (
  pullRequest: string,
) => Promise<PullRequestMergeState | undefined>;

export interface DuplicateCandidate {
  readonly id: number;
  readonly score: number;
  readonly status: Quest["status"];
  readonly title: string;
}

export type AddQuestResult =
  | {
      readonly outcome: "duplicates";
      readonly candidates: readonly DuplicateCandidate[];
      readonly evidence: readonly Evidence[];
      readonly quest: null;
      readonly warnings: readonly string[];
    }
  | {
      readonly outcome: "created" | "replayed";
      readonly candidates: readonly DuplicateCandidate[];
      readonly evidence: readonly Evidence[];
      readonly quest: Quest;
      readonly warnings: readonly string[];
    };

export interface QuestMutationResult {
  readonly changed: boolean;
  readonly evidence: readonly Evidence[];
  readonly forceRequired?: boolean;
  readonly lease_expires_at?: string | null;
  readonly quest: Quest;
  readonly snapshot?: QuestDump;
  readonly warnings: readonly string[];
}

export class LifecycleCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleCommandError";
  }
}

function missingVerificationEvidenceWarning(id: number): string {
  return `quest ${id} has no verify-stage evidence; attach evidence with --evidence <path>`;
}

async function latestTurnInPullRequest(store: QuestStore, id: number): Promise<string | undefined> {
  const events = await store.events(id);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.action !== "turnin") {
      continue;
    }
    const detail = turnInEventDetailSchema.safeParse(event.detail);
    if (detail.success && detail.data.pr !== undefined && detail.data.pr !== null) {
      return detail.data.pr;
    }
  }
  return undefined;
}

async function hasCurrentVerificationEvidence(store: QuestStore, id: number): Promise<boolean> {
  const events = await store.events(id);
  const latestTurnIn = [...events].reverse().find((event) => event.action === "turnin");
  if (latestTurnIn === undefined) {
    return false;
  }
  const dump = await store.exportAll();
  const verifyEvidenceIds = new Set(
    dump.evidence
      .filter((evidence) => evidence.quest_id === id && evidence.stage === "verify")
      .map((evidence) => evidence.id),
  );
  return events.some(
    (event) =>
      event.id > latestTurnIn.id &&
      event.action === "update" &&
      (() => {
        const detail = evidenceEventDetailSchema.safeParse(event.detail);
        return detail.success && verifyEvidenceIds.has(detail.data.evidence_id);
      })(),
  );
}

type QuestAcceptanceMode = "normal" | "force";

interface AcceptLifecycleQuestOptions {
  readonly mode?: QuestAcceptanceMode;
  readonly sessionAttribution?: SessionAttribution;
  readonly sessionGuild?: string | null;
}

interface AcceptOperationResult {
  readonly acceptance: AcceptResult;
  readonly snapshot?: QuestDump;
}

type AcceptOperation = (input: AcceptQuestInput) => Promise<AcceptOperationResult>;

export function questGuildMatches(
  quest: Pick<Quest, "guild">,
  sessionGuild: string | null,
): boolean {
  return quest.guild === null || quest.guild === sessionGuild;
}

function duplicateWarning(candidate: DuplicateCandidate): string {
  return `possible duplicate: quest ${candidate.id} (${candidate.score.toFixed(4)}) ${candidate.title}`;
}

function inferEvidenceKind(filename: string): EvidenceKind {
  switch (extname(filename).toLowerCase()) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
      return "screenshot";
    case ".log":
      return "log";
    case ".md":
    case ".pdf":
    case ".doc":
    case ".docx":
    case ".txt":
      return "doc";
    default:
      return "other";
  }
}

async function requireScopedQuest(
  store: QuestStore,
  id: number,
  scope: QuestScope,
): Promise<Quest> {
  const quest = await store.getQuest(id);
  if (quest === null || (scope.repo !== null && quest.repo !== scope.repo)) {
    throw new LifecycleCommandError(`quest ${id} not found in the selected scope`);
  }
  return quest;
}

async function attachEvidence(
  ports: LifecycleServicePorts,
  questId: number,
  request: EvidenceAttachmentRequest,
): Promise<{ changed: boolean; evidence: Evidence[]; warnings: string[] }> {
  const evidence: Evidence[] = [];
  const warnings: string[] = [];
  let changed = false;

  for (const path of request.paths) {
    const file = await ports.evidenceFiles.read(path, request.workingDirectory);
    const sha256 = await ports.blobStore.put(file.bytes);
    const kind = inferEvidenceKind(file.filename);
    const existing = (await ports.questStore.exportAll()).evidence.find(
      (candidate) =>
        candidate.quest_id === questId &&
        candidate.sha256 === sha256 &&
        candidate.filename === file.filename &&
        candidate.kind === kind &&
        candidate.stage === request.stage &&
        candidate.added_by === request.actor,
    );
    if (existing !== undefined) {
      evidence.push(existing);
      warnings.push(`evidence ${file.filename} is already attached to quest ${questId}`);
      continue;
    }

    evidence.push(
      await ports.questStore.addEvidence({
        quest_id: questId,
        sha256,
        filename: file.filename,
        kind,
        stage: request.stage,
        added_by: request.actor,
        session_guild: request.sessionGuild,
      }),
    );
    changed = true;
  }

  return { changed, evidence, warnings };
}

function normalizedNewQuest(input: NewQuest): NewQuest {
  return newQuestSchema.parse({
    ...input,
    backfill: input.backfill ?? false,
    session_guild: input.session_guild ?? null,
  });
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

async function isAddReplay(store: QuestStore, quest: Quest, input: NewQuest): Promise<boolean> {
  const addEvent = (await store.events(quest.id)).find((event) => event.action === "add");
  if (addEvent === undefined) {
    return false;
  }
  const parsed = normalizeNewQuestReplay(addEvent.detail);
  const normalizedInput = normalizeNewQuestReplay(normalizedNewQuest(input));
  return (
    parsed !== undefined &&
    normalizedInput !== undefined &&
    JSON.stringify(canonicalJson(parsed)) === JSON.stringify(canonicalJson(normalizedInput))
  );
}

function normalizeNewQuestReplay(value: unknown): NewQuestReplay | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const hasGuild = entries.some(([key]) => key === "guild");
  const withoutReplayMetadata = Object.fromEntries(
    entries.filter(
      ([key]) => key !== "branch" && key !== "lease_expires_at" && key !== "session_guild",
    ),
  );
  const parsed = newQuestReplaySchema.safeParse({
    ...withoutReplayMetadata,
    ...(hasGuild ? {} : { guild: null }),
  });
  return parsed.success ? parsed.data : undefined;
}

function duplicateCandidates(quests: readonly Quest[], input: NewQuest): DuplicateCandidate[] {
  return quests
    .map((quest) => ({
      id: quest.id,
      score: scoreDedupCandidate(input, quest),
      status: quest.status,
      title: quest.title,
    }))
    .filter(({ score }) => score >= DEDUP_CANDIDATE_SCORE)
    .sort((left, right) => right.score - left.score || left.id - right.id);
}

async function requireDuplicateTarget(
  store: QuestStore,
  duplicateOf: number | null,
): Promise<void> {
  if (duplicateOf !== null && (await store.getQuest(duplicateOf)) === null) {
    throw new LifecycleCommandError(`duplicate target quest ${duplicateOf} does not exist`);
  }
}

async function ensureReplayDuplicateLink(
  store: QuestStore,
  questId: number,
  duplicateOf: number | null,
  actor: string,
): Promise<boolean> {
  if (duplicateOf === null) {
    return true;
  }
  const duplicateLinks = (await store.exportAll()).chains.filter(
    (link) => link.quest_id === questId && link.type === "duplicate-of",
  );
  if (duplicateLinks.some((link) => link.target_id === duplicateOf)) {
    return true;
  }
  if (duplicateLinks.length > 0) {
    return false;
  }
  await store.addChainLink({
    actor,
    link: {
      quest_id: questId,
      target_id: duplicateOf,
      type: "duplicate-of",
    },
  });
  return true;
}

export async function addLifecycleQuest(
  ports: LifecycleServicePorts,
  input: NewQuest,
  options: {
    readonly duplicateOf: number | null;
    readonly evidence: EvidenceAttachmentRequest;
    readonly force: boolean;
    readonly sessionGuild: string | null;
  },
): Promise<AddQuestResult> {
  const parsed = newQuestSchema.parse(input);
  const scopedQuests = await ports.questStore.listQuests({ repo: parsed.repo });
  const candidates = duplicateCandidates(scopedQuests, parsed);
  await requireDuplicateTarget(ports.questStore, options.duplicateOf);

  for (const existing of scopedQuests) {
    if (await isAddReplay(ports.questStore, existing, parsed)) {
      const matchesRequestedLink = await ensureReplayDuplicateLink(
        ports.questStore,
        existing.id,
        options.duplicateOf,
        parsed.opened_by,
      );
      if (!matchesRequestedLink) {
        continue;
      }
      const attachments = await attachEvidence(ports, existing.id, options.evidence);
      return {
        outcome: "replayed",
        candidates,
        evidence: attachments.evidence,
        quest: existing,
        warnings: [`quest ${existing.id} was already added; no duplicate was created`].concat(
          attachments.warnings,
        ),
      };
    }
  }

  if (candidates.length > 0 && !options.force) {
    return {
      outcome: "duplicates",
      candidates,
      evidence: [],
      quest: null,
      warnings: candidates.map(duplicateWarning),
    };
  }

  const quest = await ports.questStore.addQuest({
    ...parsed,
    session_guild: options.sessionGuild,
  });
  if (options.duplicateOf !== null) {
    await ports.questStore.addChainLink({
      actor: parsed.opened_by,
      session_guild: options.sessionGuild,
      link: {
        quest_id: quest.id,
        target_id: options.duplicateOf,
        type: "duplicate-of",
      },
    });
  }
  const attachments = await attachEvidence(ports, quest.id, options.evidence);
  return {
    outcome: "created",
    candidates,
    evidence: attachments.evidence,
    quest,
    warnings: (options.force ? candidates.map(duplicateWarning) : []).concat(attachments.warnings),
  };
}

export async function acceptLifecycleQuest(
  store: QuestStore,
  scope: QuestScope,
  id: number,
  owner: string,
  options: AcceptLifecycleQuestOptions = {},
): Promise<QuestMutationResult> {
  return acceptLifecycleQuestWithOperation(store, scope, id, owner, options, async (input) => ({
    acceptance: await store.acceptQuest(input),
  }));
}

export async function acceptLifecycleQuestWithSnapshot(
  store: QuestStore,
  scope: QuestScope,
  id: number,
  owner: string,
  options: AcceptLifecycleQuestOptions = {},
): Promise<QuestMutationResult> {
  return acceptLifecycleQuestWithOperation(store, scope, id, owner, options, (input) =>
    store.acceptQuestAndExport(input),
  );
}

async function acceptLifecycleQuestWithOperation(
  store: QuestStore,
  scope: QuestScope,
  id: number,
  owner: string,
  options: AcceptLifecycleQuestOptions,
  accept: AcceptOperation,
): Promise<QuestMutationResult> {
  const sessionGuild = options.sessionGuild ?? null;
  const sessionAttribution = options.sessionAttribution ?? {};
  const force = options.mode === "force";
  const current = await requireScopedQuest(store, id, scope);
  const warning = guildMismatchWarning(current, id, sessionGuild);
  if (warning !== undefined) {
    return force
      ? acceptMismatchedGuild(current, id, owner, sessionGuild, sessionAttribution, warning, accept)
      : {
          changed: false,
          evidence: [],
          forceRequired: true,
          quest: current,
          warnings: [warning],
        };
  }
  return acceptMatchingGuild(
    current,
    id,
    owner,
    sessionGuild,
    sessionAttribution,
    force ? "force" : "normal",
    accept,
  );
}

function guildMismatchWarning(
  quest: Quest,
  id: number,
  sessionGuild: string | null,
): string | undefined {
  if (questGuildMatches(quest, sessionGuild)) {
    return undefined;
  }
  return (
    `quest ${id} is assigned to guild ${quest.guild}; session guild is ` +
    `${sessionGuild ?? "undeclared"}; use --force to override`
  );
}

async function acceptMismatchedGuild(
  current: Quest,
  id: number,
  owner: string,
  sessionGuild: string | null,
  sessionAttribution: SessionAttribution,
  warning: string,
  accept: AcceptOperation,
): Promise<QuestMutationResult> {
  if (current.status === "accepted" && current.assignee === owner) {
    return {
      changed: false,
      evidence: [],
      lease_expires_at: current.lease_expires_at,
      quest: current,
      warnings: [`quest ${id} is already assigned to ${owner}; no change was made`],
    };
  }
  if (current.assignee !== null) {
    throw new LifecycleCommandError(`quest ${id} already accepted by ${current.assignee}`);
  }
  const accepted = await accept({
    force: true,
    id,
    owner,
    ...sessionAttribution,
    session_guild: sessionGuild,
  });
  const result = accepted.acceptance;
  if (result.outcome === "guild-mismatch") {
    return guildMismatchMutation(id, result.quest, sessionGuild);
  }
  if (result.outcome === "conflict") {
    if (result.quest.status === "accepted" && result.quest.assignee === owner) {
      return {
        changed: false,
        evidence: [],
        lease_expires_at: result.quest.lease_expires_at,
        quest: result.quest,
        warnings: [`quest ${id} is already assigned to ${owner}; no change was made`],
      };
    }
    throwAcceptConflict(id, result);
  }
  const snapshot = accepted.snapshot;
  return {
    changed: true,
    evidence: [],
    lease_expires_at: result.quest.lease_expires_at,
    quest: result.quest,
    ...(snapshot === undefined ? {} : { snapshot }),
    warnings: [`${warning} (override accepted)`],
  };
}

async function acceptMatchingGuild(
  current: Quest,
  id: number,
  owner: string,
  sessionGuild: string | null,
  sessionAttribution: SessionAttribution,
  mode: QuestAcceptanceMode,
  accept: AcceptOperation,
): Promise<QuestMutationResult> {
  if (current.status === "accepted" && current.assignee === owner) {
    return {
      changed: false,
      evidence: [],
      lease_expires_at: current.lease_expires_at,
      quest: current,
      warnings: [`quest ${id} is already assigned to ${owner}; no change was made`],
    };
  }
  if (current.assignee !== null) {
    throw new LifecycleCommandError(`quest ${id} already accepted by ${current.assignee}`);
  }

  const accepted = await accept({
    force: mode === "force",
    id,
    owner,
    ...sessionAttribution,
    session_guild: sessionGuild,
  });
  const result = accepted.acceptance;
  if (result.outcome === "guild-mismatch") {
    return guildMismatchMutation(id, result.quest, sessionGuild);
  }
  if (result.outcome === "conflict") {
    if (result.quest.status === "accepted" && result.quest.assignee === owner) {
      return {
        changed: false,
        evidence: [],
        lease_expires_at: result.quest.lease_expires_at,
        quest: result.quest,
        warnings: [`quest ${id} is already assigned to ${owner}; no change was made`],
      };
    }
    throwAcceptConflict(id, result);
  }
  const snapshot = accepted.snapshot;
  return {
    changed: true,
    evidence: [],
    lease_expires_at: result.quest.lease_expires_at,
    quest: result.quest,
    ...(snapshot === undefined ? {} : { snapshot }),
    warnings: [],
  };
}

function guildMismatchMutation(
  id: number,
  quest: Quest,
  sessionGuild: string | null,
): QuestMutationResult {
  const warning = guildMismatchWarning(quest, id, sessionGuild);
  if (warning === undefined) {
    throw new Error(`quest ${id} returned an invalid guild mismatch`);
  }
  return {
    changed: false,
    evidence: [],
    forceRequired: true,
    lease_expires_at: quest.lease_expires_at,
    quest,
    warnings: [warning],
  };
}

function throwAcceptConflict(
  id: number,
  result: Extract<AcceptResult, { outcome: "conflict" }>,
): never {
  throw new LifecycleCommandError(
    result.quest.assignee === null
      ? `quest ${id} cannot be accepted from status ${result.quest.status}`
      : `quest ${id} already accepted by ${result.quest.assignee}`,
  );
}

function lastLifecycleEvent(events: Awaited<ReturnType<QuestStore["events"]>>) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (event.action === "update" && evidenceEventDetailSchema.safeParse(event.detail).success) {
      continue;
    }
    return event;
  }
  return undefined;
}

async function isTransitionReplay(
  store: QuestStore,
  id: number,
  transition: QuestTransition,
): Promise<boolean> {
  const event = lastLifecycleEvent(await store.events(id));
  if (event === undefined || event.action !== transition.action) {
    return false;
  }
  const parsed = normalizeReplayTransition(event.detail);
  return (
    parsed !== undefined &&
    JSON.stringify(canonicalJson(parsed)) ===
      JSON.stringify(canonicalJson(normalizeReplayTransition(transition)))
  );
}

function normalizeReplayTransition(
  value: unknown,
): Omit<QuestTransition, "session_effort" | "session_guild" | "session_model"> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  const action = entries.find(([key]) => key === "action")?.[1];
  const normalized =
    action === "turnin"
      ? Object.fromEntries(entries.filter(([key]) => key !== "branch"))
      : action === "complete"
        ? Object.fromEntries(
            entries.filter(
              ([key]) => key !== "force" && key !== "pr_unverified" && key !== "pr_verified_merged",
            ),
          )
        : value;
  const parsed = questTransitionSchema.safeParse(normalized);
  return parsed.success
    ? withoutSessionAttribution({
        ...parsed.data,
        session_guild: parsed.data.session_guild ?? null,
      })
    : undefined;
}

function withoutSessionAttribution<T extends QuestTransition>(
  value: T,
): Omit<T, "session_effort" | "session_guild" | "session_model"> {
  const replay = { ...value };
  delete replay.session_effort;
  delete replay.session_guild;
  delete replay.session_model;
  return replay;
}

async function completionTransitionWithMergeGate(
  store: QuestStore,
  id: number,
  transition: Extract<QuestTransition, { action: "complete" }>,
  options: LifecycleTransitionOptions,
): Promise<Extract<QuestTransition, { action: "complete" }>> {
  const pullRequest = await latestTurnInPullRequest(store, id);
  if (pullRequest === undefined) {
    return transition;
  }

  let mergeState: PullRequestMergeState | undefined;
  try {
    mergeState = await options.checkPullRequestMerge?.(pullRequest);
  } catch {
    mergeState = undefined;
  }
  if (mergeState === undefined) {
    return { ...transition, pr_unverified: true };
  }

  const state = mergeState.state.trim().toUpperCase();
  if (state !== "MERGED") {
    throw new LifecycleCommandError(
      `COMPLETE_PR_UNMERGED: quest ${id} cannot complete because PR ${mergeState.url} is ${state}; merge it, or use reopen/cancel with a reason if the work is not landing`,
    );
  }
  return { ...transition, pr_verified_merged: true };
}

export async function transitionLifecycleQuest(
  ports: LifecycleServicePorts,
  scope: QuestScope,
  id: number,
  transition: QuestTransition | undefined,
  evidenceRequest: EvidenceAttachmentRequest,
  options: LifecycleTransitionOptions,
): Promise<QuestMutationResult> {
  const current = await requireScopedQuest(ports.questStore, id, scope);
  let changed = false;
  let quest = current;
  const warnings: string[] = [];

  if (transition !== undefined) {
    if (await isTransitionReplay(ports.questStore, id, transition)) {
      warnings.push(`quest ${id} already recorded ${transition.action}; no change was made`);
    } else {
      const effectiveTransition =
        transition.action === "complete"
          ? await completionTransitionWithMergeGate(ports.questStore, id, transition, options)
          : transition;
      quest = await ports.questStore.transition(id, effectiveTransition);
      changed = true;
    }
  }

  const attachments = await attachEvidence(ports, id, evidenceRequest);
  if (
    transition?.action === "complete" &&
    current.status === "turned_in" &&
    !(await hasCurrentVerificationEvidence(ports.questStore, id))
  ) {
    warnings.push(missingVerificationEvidenceWarning(id));
  }
  return {
    changed: changed || attachments.changed,
    evidence: attachments.evidence,
    quest,
    warnings: warnings.concat(attachments.warnings),
  };
}

export async function touchLifecycleQuest(
  store: QuestStore,
  scope: QuestScope,
  id: number,
  owner: string,
  sessionGuild: string | null = null,
  sessionAttribution: SessionAttribution = {},
): Promise<QuestMutationResult> {
  await requireScopedQuest(store, id, scope);
  const quest = await store.touchQuest({
    id,
    owner,
    ...sessionAttribution,
    session_guild: sessionGuild,
  });
  return {
    changed: true,
    evidence: [],
    lease_expires_at: quest.lease_expires_at,
    quest,
    warnings: [],
  };
}
