import { parseHttpUrl } from "./pr";

export interface QuestLogInteractionState {
  readonly areaIndex: number;
  readonly areaKey: string;
  readonly selectedIndex: number;
  readonly selectedQuestId: number | undefined;
  readonly showDone: boolean;
}

export interface QuestLogKey {
  readonly name: string;
  readonly raw: string;
  readonly sequence: string;
  readonly shift: boolean;
}

export interface QuestLogInteractionContext {
  readonly areaCount: number;
  readonly areaKeys?: readonly string[];
  readonly pr?: string | null;
  readonly questId: number | undefined;
  readonly visibleCount: number;
  readonly visibleQuestIds?: readonly number[];
}

export type QuestLogIntent =
  | { readonly type: "cycle-scope" }
  | { readonly type: "none" }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "open-evidence"; readonly id: number }
  | { readonly type: "open-pr"; readonly url: string }
  | { readonly type: "quit" }
  | { readonly type: "toggle-done" };

export interface QuestLogInteractionResult {
  readonly intent: QuestLogIntent;
  readonly state: QuestLogInteractionState;
}

export const INITIAL_QUEST_LOG_INTERACTION: QuestLogInteractionState = {
  areaIndex: 0,
  areaKey: "all",
  selectedIndex: 0,
  selectedQuestId: undefined,
  showDone: false,
};

function isKey(key: QuestLogKey, value: string): boolean {
  return key.name === value || key.raw === value || key.sequence === value;
}

function normalizeState(
  state: QuestLogInteractionState,
  context: QuestLogInteractionContext,
): QuestLogInteractionState {
  const areaKeys = context.areaKeys ?? fallbackAreaKeys(context.areaCount);
  const areaIndex = Math.max(0, areaKeys.indexOf(state.areaKey));
  const selection = selectionForVisibleQuests(state, context);
  return {
    areaIndex,
    areaKey: areaKeys[areaIndex] ?? "all",
    selectedIndex: selection.index,
    selectedQuestId: selection.questId,
    showDone: state.showDone,
  };
}

function selectionForVisibleQuests(
  state: QuestLogInteractionState,
  context: QuestLogInteractionContext,
): { readonly index: number; readonly questId: number | undefined } {
  const visibleQuestIds = context.visibleQuestIds ?? [];
  if (context.visibleCount === 0) {
    return { index: 0, questId: undefined };
  }
  const identityIndex =
    state.selectedQuestId === undefined ? -1 : visibleQuestIds.indexOf(state.selectedQuestId);
  const index =
    identityIndex >= 0
      ? identityIndex
      : Math.min(Math.max(0, state.selectedIndex), context.visibleCount - 1);
  return { index, questId: visibleQuestIds[index] };
}

function fallbackAreaKeys(areaCount: number): readonly string[] {
  return [
    "all",
    ...Array.from({ length: Math.max(0, areaCount - 1) }, (_, index) => `area:${index}`),
  ];
}

function moveSelection(selectedIndex: number, direction: -1 | 1, visibleCount: number): number {
  if (visibleCount === 0) {
    return 0;
  }
  return Math.min(Math.max(0, selectedIndex + direction), visibleCount - 1);
}

function moveArea(areaIndex: number, direction: -1 | 1, areaCount: number): number {
  if (areaCount <= 1) {
    return 0;
  }
  return (areaIndex + direction + areaCount) % areaCount;
}

function tabState(
  state: QuestLogInteractionState,
  key: QuestLogKey,
  context: QuestLogInteractionContext,
): QuestLogInteractionState {
  const areaKeys = context.areaKeys ?? fallbackAreaKeys(context.areaCount);
  const areaIndex = moveArea(state.areaIndex, key.shift ? -1 : 1, areaKeys.length);
  return {
    ...state,
    areaIndex,
    areaKey: areaKeys[areaIndex] ?? state.areaKey,
    selectedIndex: 0,
    selectedQuestId: context.visibleQuestIds?.[0],
  };
}

function isEvidenceKey(key: QuestLogKey): boolean {
  return [key.name, key.raw, key.sequence].some((value) => value === "e" || value === "E");
}

function evidenceResult(
  state: QuestLogInteractionState,
  questId: number | undefined,
): QuestLogInteractionResult {
  return questId === undefined
    ? {
        intent: { type: "notice", message: "Select a quest before opening evidence" },
        state,
      }
    : { intent: { id: questId, type: "open-evidence" }, state };
}

function prResult(
  state: QuestLogInteractionState,
  questId: number | undefined,
  pr: string | null | undefined,
): QuestLogInteractionResult {
  if (questId === undefined) {
    return {
      intent: { type: "notice", message: "Select a quest before opening its PR" },
      state,
    };
  }
  const url = pr === null || pr === undefined ? undefined : parseHttpUrl(pr);
  return url === undefined
    ? { intent: { type: "notice", message: `quest ${questId} has no PR` }, state }
    : { intent: { type: "open-pr", url }, state };
}

function moveSelectionState(
  state: QuestLogInteractionState,
  direction: -1 | 1,
  context: QuestLogInteractionContext,
): QuestLogInteractionState {
  const selectedIndex = moveSelection(state.selectedIndex, direction, context.visibleCount);
  return {
    ...state,
    selectedIndex,
    selectedQuestId: context.visibleQuestIds?.[selectedIndex],
  };
}

export function reduceReadOnlyInteraction(
  state: QuestLogInteractionState,
  key: QuestLogKey,
  context: QuestLogInteractionContext,
): QuestLogInteractionResult {
  const normalized = normalizeState(state, context);

  if (isKey(key, "q")) {
    return { intent: { type: "quit" }, state: normalized };
  }
  if (isKey(key, "up") || isKey(key, "k")) {
    return {
      intent: { type: "none" },
      state: moveSelectionState(normalized, -1, context),
    };
  }
  if (isKey(key, "down") || isKey(key, "j")) {
    return {
      intent: { type: "none" },
      state: moveSelectionState(normalized, 1, context),
    };
  }
  if (isKey(key, "tab")) {
    return { intent: { type: "none" }, state: tabState(normalized, key, context) };
  }
  if (isKey(key, "r")) {
    return {
      intent: { type: "cycle-scope" },
      state: {
        ...normalized,
        areaIndex: 0,
        areaKey: "all",
        selectedIndex: 0,
        selectedQuestId: undefined,
      },
    };
  }
  if (isKey(key, "d")) {
    return {
      intent: { type: "toggle-done" },
      state: {
        ...normalized,
        selectedIndex: 0,
        selectedQuestId: context.visibleQuestIds?.[0],
        showDone: !normalized.showDone,
      },
    };
  }
  if (isEvidenceKey(key)) {
    return evidenceResult(normalized, context.questId);
  }
  if (isKey(key, "p")) {
    return prResult(normalized, context.questId, context.pr);
  }
  return { intent: { type: "none" }, state: normalized };
}
