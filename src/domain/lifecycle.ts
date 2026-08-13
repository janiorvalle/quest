import type { Quest, QuestKind, QuestStatus, QuestTransition, Verdict } from "../schema";
import { signoffNotCompleteInstruction } from "./signoff";

type LifecycleAction = QuestTransition["action"];

export type LifecycleInvalidStateCode =
  | "ABANDON_INVALID_STATE"
  | "CANCEL_INVALID_STATE"
  | "COMPLETE_INVALID_STATE"
  | "REOPEN_INVALID_STATE"
  | "SIGNOFF_NOT_COMPLETE"
  | "TURNIN_INVALID_STATE"
  | "VERDICT_INVALID_STATE";

export class LifecycleInvalidStateError extends Error {
  readonly code: LifecycleInvalidStateCode;
  readonly receiverMessage: string;

  constructor(code: LifecycleInvalidStateCode, receiverMessage: string) {
    super(`[${code}] ${receiverMessage}`);
    this.name = "LifecycleInvalidStateError";
    this.code = code;
    this.receiverMessage = receiverMessage;
  }
}

function isLifecycleActionAllowed(
  quest: Pick<Quest, "kind" | "status">,
  action: LifecycleAction,
): boolean {
  switch (action) {
    case "abandon":
      return quest.status === "accepted";
    case "verdict":
      return canApplyVerdict(quest.kind, quest.status);
    case "turnin":
      return quest.status === "accepted";
    case "complete":
      return quest.status === "turned_in";
    case "signoff":
      return quest.status === "complete";
    case "cancel":
      return isLegalStatusTransition(quest.status, "dropped");
    case "reopen":
      return (
        quest.status === "turned_in" || quest.status === "complete" || quest.status === "dropped"
      );
    case "update":
      return true;
  }
}

function invalidStateError(
  quest: Pick<Quest, "id" | "kind" | "status">,
  action: Exclude<LifecycleAction, "update">,
): LifecycleInvalidStateError {
  switch (action) {
    case "abandon":
      return new LifecycleInvalidStateError(
        "ABANDON_INVALID_STATE",
        `quest ${quest.id} is ${quest.status}; abandon releases only an accepted quest. Run \`quest show ${quest.id}\` and continue from its current state; retry \`quest abandon ${quest.id}\` only after the quest is accepted. No state changed.`,
      );
    case "verdict":
      return new LifecycleInvalidStateError(
        "VERDICT_INVALID_STATE",
        `quest ${quest.id} is ${quest.status} (${quest.kind}); verdict applies only to bugs in open or accepted. For a task, use update or cancel. If this bug is open, accept it before retrying; if it is turned_in, complete, or dropped, reopen it first. No state changed.`,
      );
    case "turnin":
      return new LifecycleInvalidStateError(
        "TURNIN_INVALID_STATE",
        `quest ${quest.id} is ${quest.status}; turn-in requires accepted. If it is open, run \`quest accept ${quest.id}\`; if it is turned_in, complete, or dropped, reopen it before accepting. Finish the work, then retry \`quest turnin ${quest.id}\` with the PR, summary, actual files, and evidence. No state changed.`,
      );
    case "complete":
      return new LifecycleInvalidStateError(
        "COMPLETE_INVALID_STATE",
        `quest ${quest.id} is ${quest.status}; completion requires turned_in. If it is open, run \`quest accept ${quest.id}\`; if it is complete or dropped, reopen it before accepting. Finish the work and \`quest turnin ${quest.id}\` with a PR, summary, actual files, and evidence before retrying \`quest complete ${quest.id}\`. No state changed.`,
      );
    case "signoff":
      return new LifecycleInvalidStateError(
        "SIGNOFF_NOT_COMPLETE",
        signoffNotCompleteInstruction(quest.id, quest.status),
      );
    case "cancel":
      return new LifecycleInvalidStateError(
        "CANCEL_INVALID_STATE",
        `quest ${quest.id} is ${quest.status}; cancel applies only before completion or cancellation. Leave the terminal quest unchanged, or run \`quest reopen ${quest.id} --notes "<why work resumes>"\` before continuing. No state changed.`,
      );
    case "reopen":
      return new LifecycleInvalidStateError(
        "REOPEN_INVALID_STATE",
        `quest ${quest.id} is ${quest.status}; reopen applies only to turned_in, complete, or dropped. Continue the current workflow, or use \`quest cancel ${quest.id} --reason "<why work stops>"\` when it should end. No state changed.`,
      );
  }
}

export function assertLifecycleActionAllowed(
  quest: Pick<Quest, "id" | "kind" | "status">,
  action: LifecycleAction,
): void {
  if (isLifecycleActionAllowed(quest, action)) {
    return;
  }
  if (action === "update") {
    throw new Error("update unexpectedly failed lifecycle validation");
  }
  throw invalidStateError(quest, action);
}

export function initialStatusForKind(kind: QuestKind): QuestStatus {
  switch (kind) {
    case "bug":
    case "task":
      return "open";
    default:
      return assertNever(kind);
  }
}

export function isLegalStatusTransition(from: QuestStatus, to: QuestStatus): boolean {
  switch (from) {
    case "open":
      return to === "accepted" || to === "dropped";
    case "accepted":
      return to === "open" || to === "turned_in" || to === "dropped";
    case "turned_in":
      return to === "open" || to === "complete" || to === "dropped";
    case "complete":
    case "dropped":
      return to === "open";
    default:
      return assertNever(from);
  }
}

export function isDispatchableQuest(value: Pick<Quest, "kind" | "status">): boolean {
  return value.status === "open";
}

export function canApplyVerdict(kind: QuestKind, status: QuestStatus): boolean {
  return kind === "bug" && (status === "open" || status === "accepted");
}

export function statusForVerdict(verdict: Verdict): QuestStatus {
  switch (verdict) {
    case "actionable":
      return "open";
    case "not-reproduced":
      return "dropped";
    case "works-as-intended":
    case "invalid":
    case "external":
    case "duplicate":
    case "wont-do":
      return "dropped";
    default:
      return assertNever(verdict);
  }
}

export function statusForRetestVerdict(verdict: Verdict): QuestStatus {
  return verdict === "not-reproduced" ? "open" : statusForVerdict(verdict);
}

export function statusAfterClaimRelease(): QuestStatus {
  return "open";
}

export function isValidBackfill(value: Pick<Quest, "kind" | "status" | "verdict">): boolean {
  if (value.kind === "task") {
    return value.verdict === null;
  }

  switch (value.status) {
    case "open":
      return (
        value.verdict === null ||
        value.verdict === "actionable" ||
        value.verdict === "not-reproduced"
      );
    case "accepted":
    case "turned_in":
    case "complete":
      return (
        value.verdict === null ||
        value.verdict === "actionable" ||
        value.verdict === "not-reproduced"
      );
    case "dropped":
      return value.verdict !== null && value.verdict !== "actionable";
    default:
      return assertNever(value.status);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled value: ${String(value)}`);
}
