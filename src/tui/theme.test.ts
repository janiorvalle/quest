import { describe, expect, test } from "bun:test";

import {
  DENSE_THEME,
  findQuestTheme,
  QUEST_THEMES,
  type QuestTheme,
  questThemeAfter,
  questThemeNames,
} from "./theme";

const SECOND_THEME: QuestTheme = { ...DENSE_THEME, name: "test-second" };
const THIRD_THEME: QuestTheme = { ...DENSE_THEME, name: "test-third" };
const REGISTRY: readonly QuestTheme[] = [DENSE_THEME, SECOND_THEME, THIRD_THEME];

describe("theme registry", () => {
  test("ships dense as the only theme, and dense is the default", () => {
    expect(QUEST_THEMES).toEqual([DENSE_THEME]);
    expect(questThemeNames()).toEqual(["dense"]);
    expect(findQuestTheme("dense")).toBe(DENSE_THEME);
    expect(findQuestTheme("tavern")).toBeUndefined();
  });

  test("cycles through every registered theme and wraps back to the first", () => {
    expect(questThemeAfter(DENSE_THEME, REGISTRY)).toBe(SECOND_THEME);
    expect(questThemeAfter(SECOND_THEME, REGISTRY)).toBe(THIRD_THEME);
    expect(questThemeAfter(THIRD_THEME, REGISTRY)).toBe(DENSE_THEME);
  });

  test("cycling a single-theme registry stays on that theme", () => {
    expect(questThemeAfter(DENSE_THEME, [DENSE_THEME])).toBe(DENSE_THEME);
    expect(questThemeAfter(DENSE_THEME)).toBe(DENSE_THEME);
  });

  test("cycling from a theme the registry does not hold lands on the first one", () => {
    expect(questThemeAfter({ ...DENSE_THEME, name: "retired" }, REGISTRY)).toBe(DENSE_THEME);
  });
});

describe("dense theme", () => {
  test("keeps the dense contract tokens stable", () => {
    expect(DENSE_THEME.palette).toEqual({
      accent: "#62c4c9",
      background: "#0b0f12",
      borderActive: "#3d5866",
      borderIdle: "#24313a",
      hint: "#62c4c9",
      lane: "#bc8cff",
      sectionLabel: "#7fa3b8",
      selection: "#c9d4d9",
      selectionInk: "#0b0f12",
      stripe: "#0d1216",
      surface: "#0e1418",
      textBright: "#c9d4d9",
      textDim: "#37444b",
      textMuted: "#5f7078",
      textPrimary: "#c9d4d9",
      textSecondary: "#9fb2ba",
      warn: "#e3c05c",
    });
    expect(DENSE_THEME.status).toEqual({
      accepted: { color: "#7fa3b8", label: "◐ active" },
      complete: { color: "#7bc96f", label: "✓ complete" },
      dropped: { color: "#37444b", label: "✕ dropped" },
      open: { color: "#d1706b", label: "○ open" },
      ready: { color: "#62c4c9", label: "● ready" },
      turned_in: { color: "#e3c05c", label: "◆ review" },
    });
    expect(DENSE_THEME.labels.statusPhrase).toEqual({
      accepted: "in progress",
      complete: "verified",
      dropped: "closed",
      open: "needs triage",
      ready: "unclaimed",
      turned_in: "awaiting verification",
    });
  });

  test("keeps view code free of literal colors", async () => {
    for (const name of ["components.tsx", "quest-log.tsx", "launch.tsx"]) {
      const source = await Bun.file(new URL(name, import.meta.url)).text();
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
