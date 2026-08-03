import type { Quest, QuestKind, QuestStatus, Verdict } from "../schema";

export function initialStatusForKind(kind: QuestKind): QuestStatus {
  switch (kind) {
    case "bug":
      return "open";
    case "task":
      return "ready";
    default:
      return assertNever(kind);
  }
}

export function isLegalStatusTransition(from: QuestStatus, to: QuestStatus): boolean {
  switch (from) {
    case "open":
      return to === "ready" || to === "accepted" || to === "dropped";
    case "ready":
      return to === "accepted" || to === "dropped";
    case "accepted":
      return to === "open" || to === "ready" || to === "turned_in" || to === "dropped";
    case "turned_in":
      return to === "open" || to === "ready" || to === "complete" || to === "dropped";
    case "complete":
      return to === "open" || to === "ready";
    case "dropped":
      return to === "open" || to === "ready";
    default:
      return assertNever(from);
  }
}

export function isDispatchableQuest(value: Pick<Quest, "kind" | "status">): boolean {
  return value.status === "ready" || (value.kind === "bug" && value.status === "open");
}

export function canApplyVerdict(kind: QuestKind, status: QuestStatus): boolean {
  return kind === "bug" && (status === "open" || status === "accepted");
}

export function statusForVerdict(verdict: Verdict): QuestStatus {
  switch (verdict) {
    case "actionable":
      return "ready";
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

export function statusAfterClaimRelease(value: Pick<Quest, "kind" | "verdict">): QuestStatus {
  return value.kind === "bug" && value.verdict !== "actionable" ? "open" : "ready";
}

export function isValidBackfill(value: Pick<Quest, "kind" | "status" | "verdict">): boolean {
  if (value.kind === "task") {
    return value.verdict === null && value.status !== "open";
  }

  switch (value.status) {
    case "open":
      return value.verdict === null || value.verdict === "not-reproduced";
    case "ready":
      return value.verdict === "actionable";
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
