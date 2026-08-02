import { describe, expect, test } from "bun:test";
import { areaLabel, areaTabKey } from "./components";
import {
  INITIAL_QUEST_LOG_INTERACTION,
  type QuestLogInteractionContext,
  type QuestLogInteractionState,
  reduceReadOnlyInteraction,
} from "./interaction";

const context: QuestLogInteractionContext = {
  areaCount: 3,
  areaKeys: ["all", "area:backup", "area:tui"],
  pr: "https://github.com/janiorvalle/quest/pull/52",
  questId: 72,
  visibleCount: 4,
};

function key(name: string, sequence = name, shift = false) {
  return { name, raw: sequence, sequence, shift };
}

function reduce(state: QuestLogInteractionState, name: string, sequence = name, shift = false) {
  return reduceReadOnlyInteraction(state, key(name, sequence, shift), context);
}

describe("read-only quest log keymap", () => {
  test("keeps movement and area navigation bounded", () => {
    let state = INITIAL_QUEST_LOG_INTERACTION;

    state = reduce(state, "up").state;
    expect(state.selectedIndex).toBe(0);
    state = reduce(state, "j").state;
    state = reduce(state, "down").state;
    expect(state.selectedIndex).toBe(2);
    state = reduce(state, "k").state;
    state = reduce(state, "up").state;
    expect(state.selectedIndex).toBe(0);

    state = reduce(state, "tab", "\t").state;
    expect(state.areaIndex).toBe(1);
    state = reduce(state, "tab", "\t", true).state;
    expect(state.areaIndex).toBe(0);
  });

  test("exposes only the read-only actions", () => {
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "d")).toEqual({
      intent: { type: "toggle-done" },
      state: {
        areaIndex: 0,
        areaKey: "all",
        selectedIndex: 0,
        selectedQuestId: undefined,
        showDone: true,
        sortMode: "plan",
      },
    });
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "E")).toEqual({
      intent: { id: 72, type: "open-evidence" },
      state: INITIAL_QUEST_LOG_INTERACTION,
    });
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "e").intent).toEqual({
      id: 72,
      type: "open-evidence",
    });
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "e", "e", true).intent).toEqual({
      id: 72,
      type: "open-evidence",
    });
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "p").intent).toEqual({
      type: "open-pr",
      url: "https://github.com/janiorvalle/quest/pull/52",
    });
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "r").intent).toEqual({
      type: "cycle-scope",
    });
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "q").intent).toEqual({ type: "quit" });

    const flat = reduce(INITIAL_QUEST_LOG_INTERACTION, "o");
    expect(flat.intent).toEqual({ type: "toggle-sort" });
    expect(flat.state.sortMode).toBe("flat");
    expect(reduce(flat.state, "o").state.sortMode).toBe("plan");

    for (const forbidden of ["return", "a", "c", "s", "t", "v", "y", "/"]) {
      expect(reduce(INITIAL_QUEST_LOG_INTERACTION, forbidden).intent).toEqual({ type: "none" });
    }
  });

  test("resets area and row selection when cycling repository scope", () => {
    let state = reduce(INITIAL_QUEST_LOG_INTERACTION, "down").state;
    state = reduce(state, "tab").state;

    const result = reduce(state, "r");

    expect(result.intent).toEqual({ type: "cycle-scope" });
    expect(result.state).toMatchObject({
      areaIndex: 0,
      areaKey: "all",
      selectedIndex: 0,
      selectedQuestId: undefined,
    });
  });

  test("shows the no-PR notice for missing and unsafe PR fields", () => {
    expect(
      reduceReadOnlyInteraction(INITIAL_QUEST_LOG_INTERACTION, key("p"), {
        ...context,
        pr: null,
      }).intent,
    ).toEqual({ message: "quest 72 has no PR", type: "notice" });
    expect(
      reduceReadOnlyInteraction(INITIAL_QUEST_LOG_INTERACTION, key("p"), {
        ...context,
        pr: "javascript:alert(1)",
      }).intent,
    ).toEqual({ message: "quest 72 has no PR", type: "notice" });
  });

  test("requires a selected quest before opening evidence", () => {
    const result = reduceReadOnlyInteraction(INITIAL_QUEST_LOG_INTERACTION, key("E"), {
      ...context,
      questId: undefined,
    });
    expect(result.intent).toEqual({
      message: "Select a quest before opening evidence",
      type: "notice",
    });
  });

  test("preserves the selected area identity when live tabs reorder", () => {
    const selected = reduce(INITIAL_QUEST_LOG_INTERACTION, "tab", "\t").state;
    const result = reduceReadOnlyInteraction(selected, key("", ""), {
      ...context,
      areaKeys: ["all", "area:alpha", "area:backup", "area:tui"],
    });
    expect(result.state.areaKey).toBe("area:backup");
    expect(result.state.areaIndex).toBe(2);
  });

  test("preserves the selected quest identity when live rows reorder", () => {
    const initial = {
      ...context,
      visibleQuestIds: [10, 20, 30, 40],
    };
    const selected = reduceReadOnlyInteraction(INITIAL_QUEST_LOG_INTERACTION, key("down"), initial);
    expect(selected.state.selectedQuestId).toBe(20);

    const result = reduceReadOnlyInteraction(selected.state, key("", ""), {
      ...initial,
      visibleQuestIds: [5, 20, 30, 40],
    });
    expect(result.state.selectedIndex).toBe(1);
    expect(result.state.selectedQuestId).toBe(20);
  });
});

test("area tabs distinguish reserved labels from real area values", () => {
  expect(areaTabKey(undefined)).not.toBe(areaTabKey("all"));
  expect(areaTabKey(null)).not.toBe(areaTabKey("unassigned"));
  expect(areaLabel("all")).toBe("all · area");
  expect(areaLabel("unassigned")).toBe("unassigned · area");
});
