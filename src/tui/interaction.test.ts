import { describe, expect, test } from "bun:test";
import { areaLabel, areaTabKey } from "./components";
import {
  INITIAL_QUEST_LOG_INTERACTION,
  type QuestLogInteractionContext,
  type QuestLogInteractionState,
  reduceReadOnlyInteraction,
  reduceReadOnlyScroll,
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

  test("tab still switches areas rather than cycling the theme", () => {
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "tab", "\t").intent).toEqual({ type: "none" });
  });

  test("g round-trips the display-only sign-off lens and removes dev-only controls", () => {
    const signoff = reduce(INITIAL_QUEST_LOG_INTERACTION, "g");
    expect(signoff).toEqual({
      intent: { lens: "signoff", type: "toggle-lens" },
      state: {
        ...INITIAL_QUEST_LOG_INTERACTION,
        areaIndex: 0,
        areaKey: "all",
        detailScrollOffset: 0,
        lens: "signoff",
        selectedIndex: 0,
        selectedQuestId: undefined,
        selectedQuestKey: undefined,
      },
    });
    expect(reduce(signoff.state, "g")).toMatchObject({
      intent: { lens: "dev", type: "toggle-lens" },
      state: { lens: "dev" },
    });
    expect(reduce(signoff.state, "d").intent).toEqual({ type: "none" });
    expect(reduce(signoff.state, "o").intent).toEqual({ type: "none" });
    expect(reduce(signoff.state, "tab").intent).toEqual({ type: "none" });
  });

  test("exposes only the read-only actions", () => {
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "d")).toEqual({
      intent: { type: "toggle-done" },
      state: {
        areaIndex: 0,
        areaKey: "all",
        detailScrollOffset: 0,
        lens: "dev",
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
    expect(reduce(INITIAL_QUEST_LOG_INTERACTION, "t")).toEqual({
      intent: { type: "cycle-theme" },
      state: INITIAL_QUEST_LOG_INTERACTION,
    });

    const flat = reduce(INITIAL_QUEST_LOG_INTERACTION, "o");
    expect(flat.intent).toEqual({ type: "toggle-sort" });
    expect(flat.state.sortMode).toBe("flat");
    expect(reduce(flat.state, "o").state.sortMode).toBe("plan");

    for (const forbidden of ["return", "a", "c", "s", "v", "y", "/"]) {
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

  test("keeps duplicate display IDs distinct by repository", () => {
    const federatedContext = {
      ...context,
      visibleQuestIds: [1, 1],
      visibleQuestKeys: ["alpha\u00001", "beta\u00001"],
    };
    const selected = reduceReadOnlyInteraction(
      INITIAL_QUEST_LOG_INTERACTION,
      key("down"),
      federatedContext,
    );

    expect(selected.state.selectedIndex).toBe(1);
    expect(selected.state.selectedQuestId).toBe(1);
    expect(selected.state.selectedQuestKey).toBe("beta\u00001");

    const reordered = reduceReadOnlyInteraction(selected.state, key("", ""), {
      ...federatedContext,
      visibleQuestIds: [1, 1],
      visibleQuestKeys: ["beta\u00001", "alpha\u00001"],
    });
    expect(reordered.state.selectedIndex).toBe(0);
    expect(reordered.state.selectedQuestKey).toBe("beta\u00001");
  });

  test("carries the selected repository into evidence intents", () => {
    expect(
      reduceReadOnlyInteraction(INITIAL_QUEST_LOG_INTERACTION, key("e"), {
        ...context,
        repository: "beta",
      }).intent,
    ).toEqual({ id: 72, repository: "beta", type: "open-evidence" });
  });

  test("uses uppercase J/K for bounded detail scrolling and resets on selection", () => {
    const scrollingContext = {
      ...context,
      detailContentRows: 10,
      detailViewportRows: 4,
      visibleQuestIds: [72, 73, 74, 75],
    };
    let state = reduceReadOnlyInteraction(
      INITIAL_QUEST_LOG_INTERACTION,
      key("J", "J"),
      scrollingContext,
    ).state;
    expect(state).toMatchObject({ detailScrollOffset: 1, selectedIndex: 0 });

    state = reduceReadOnlyInteraction(state, key("j", "J", true), scrollingContext).state;
    expect(state.detailScrollOffset).toBe(2);
    state = reduceReadOnlyInteraction(state, key("J", "J"), scrollingContext).state;
    state = reduceReadOnlyInteraction(state, key("J", "J"), scrollingContext).state;
    state = reduceReadOnlyInteraction(state, key("J", "J"), scrollingContext).state;
    state = reduceReadOnlyInteraction(state, key("J", "J"), scrollingContext).state;
    expect(state.detailScrollOffset).toBe(6);

    state = reduceReadOnlyInteraction(state, key("K", "K"), scrollingContext).state;
    expect(state.detailScrollOffset).toBe(5);
    state = reduceReadOnlyInteraction(state, key("k", "K", true), scrollingContext).state;
    expect(state.detailScrollOffset).toBe(4);

    const moved = reduceReadOnlyInteraction(state, key("j"), scrollingContext).state;
    expect(moved).toMatchObject({ detailScrollOffset: 0, selectedIndex: 1, selectedQuestId: 73 });
  });

  test("maps one vertical wheel event to the hovered region's keyboard action", () => {
    const scrollingContext = {
      ...context,
      detailContentRows: 10,
      detailViewportRows: 4,
      visibleQuestIds: [72, 73, 74, 75],
    };

    const detail = reduceReadOnlyScroll(
      INITIAL_QUEST_LOG_INTERACTION,
      "detail",
      "down",
      scrollingContext,
    );
    expect(detail.state).toMatchObject({ detailScrollOffset: 1, selectedIndex: 0 });

    const list = reduceReadOnlyScroll(detail.state, "list", "down", scrollingContext);
    expect(list.state).toMatchObject({
      detailScrollOffset: 0,
      selectedIndex: 1,
      selectedQuestId: 73,
    });

    expect(reduceReadOnlyScroll(list.state, "list", "up", scrollingContext).state).toMatchObject({
      selectedIndex: 0,
      selectedQuestId: 72,
    });
    expect(
      reduceReadOnlyScroll(INITIAL_QUEST_LOG_INTERACTION, "detail", "up", scrollingContext).state
        .detailScrollOffset,
    ).toBe(0);
  });
});

test("area tabs distinguish reserved labels from real area values", () => {
  expect(areaTabKey(undefined)).not.toBe(areaTabKey("all"));
  expect(areaTabKey(null)).not.toBe(areaTabKey("unassigned"));
  expect(areaLabel("all")).toBe("all · area");
  expect(areaLabel("unassigned")).toBe("unassigned · area");
});
