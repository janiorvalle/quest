import { describe, expect, test } from "bun:test";

import { stringWidth } from "bun";

import {
  DENSE_THEME,
  findQuestTheme,
  QUEST_THEMES,
  type QuestTheme,
  questPriorityInk,
  questStatusText,
  questThemeAfter,
  questThemeNames,
  TAVERN_THEME,
} from "./theme";

const SECOND_THEME: QuestTheme = { ...DENSE_THEME, name: "test-second" };
const THIRD_THEME: QuestTheme = { ...DENSE_THEME, name: "test-third" };
const REGISTRY: readonly QuestTheme[] = [DENSE_THEME, SECOND_THEME, THIRD_THEME];

describe("theme registry", () => {
  test("ships dense and tavern, with dense first as the default", () => {
    expect(QUEST_THEMES).toEqual([DENSE_THEME, TAVERN_THEME]);
    expect(questThemeNames()).toEqual(["dense", "tavern"]);
    expect(findQuestTheme("dense")).toBe(DENSE_THEME);
    expect(findQuestTheme("tavern")).toBe(TAVERN_THEME);
    expect(findQuestTheme("ledger")).toBeUndefined();
  });

  test("t reaches tavern from dense and comes back", () => {
    expect(questThemeAfter(DENSE_THEME)).toBe(TAVERN_THEME);
    expect(questThemeAfter(TAVERN_THEME)).toBe(DENSE_THEME);
  });

  test("cycles through every registered theme and wraps back to the first", () => {
    expect(questThemeAfter(DENSE_THEME, REGISTRY)).toBe(SECOND_THEME);
    expect(questThemeAfter(SECOND_THEME, REGISTRY)).toBe(THIRD_THEME);
    expect(questThemeAfter(THIRD_THEME, REGISTRY)).toBe(DENSE_THEME);
  });

  test("cycling a single-theme registry stays on that theme", () => {
    expect(questThemeAfter(DENSE_THEME, [DENSE_THEME])).toBe(DENSE_THEME);
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
      pullRequest: "#e3c05c",
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
      accepted: { color: "#7fa3b8", glyph: "◐", label: "active" },
      complete: { color: "#7bc96f", glyph: "✓", label: "complete" },
      dropped: { color: "#37444b", glyph: "✕", label: "dropped" },
      open: { color: "#d1706b", glyph: "○", label: "open" },
      ready: { color: "#62c4c9", glyph: "●", label: "ready" },
      turned_in: { color: "#e3c05c", glyph: "◆", label: "review" },
    });
    expect(DENSE_THEME.blockedStatus).toEqual({ glyph: "○", label: "blocked" });
    expect(DENSE_THEME.priorityInk).toEqual({ 1: "#d1706b", 2: "#5f7078", 3: "#5f7078" });
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

/**
 * Adding tavern meant growing the theme vocabulary: the blocked status text, the priority ink, the
 * pull-request color and the split of a status glyph from its word all moved out of the view and
 * into theme data. None of that may change what dense paints. Each expectation below pins a token
 * to the value the view hardcoded before the move, so the refactor stays provably neutral.
 *
 * The frame-level proof lives with quest 194: dense rendered on 8b62421 against dense rendered on
 * this branch differs in zero characters and zero colors, only in glyph weight.
 */
describe("dense survives the theme-token refactor unchanged", () => {
  test("composes the status labels the view used to hardcode", () => {
    expect(questStatusText(DENSE_THEME.status.accepted)).toBe("◐ active");
    expect(questStatusText(DENSE_THEME.status.complete)).toBe("✓ complete");
    expect(questStatusText(DENSE_THEME.status.dropped)).toBe("✕ dropped");
    expect(questStatusText(DENSE_THEME.status.open)).toBe("○ open");
    expect(questStatusText(DENSE_THEME.status.ready)).toBe("● ready");
    expect(questStatusText(DENSE_THEME.status.turned_in)).toBe("◆ review");
  });

  test("still spells the blocked cell '○ blocked', which the view had as a literal", () => {
    expect(`${DENSE_THEME.blockedStatus.glyph} ${DENSE_THEME.blockedStatus.label}`).toBe(
      "○ blocked",
    );
  });

  test("reproduces the old priority coloring: p1 the open color, p2 and p3 muted", () => {
    expect(questPriorityInk(DENSE_THEME, 1)).toBe(DENSE_THEME.status.open.color);
    expect(questPriorityInk(DENSE_THEME, 2)).toBe(DENSE_THEME.palette.textMuted);
    expect(questPriorityInk(DENSE_THEME, 3)).toBe(DENSE_THEME.palette.textMuted);
  });

  test("keeps the pull-request marker on the same color the warn token gave it", () => {
    expect(DENSE_THEME.palette.pullRequest).toBe(DENSE_THEME.palette.warn);
  });

  test("keeps the blocked-flag marker, renamed but not changed", () => {
    expect(DENSE_THEME.glyphs.blockedFlag).toBe("⛓");
  });
});

describe("tavern theme", () => {
  test("carries the blessed palette", () => {
    expect(TAVERN_THEME.palette).toEqual({
      accent: "#e8b04a",
      background: "#241a10",
      borderActive: "#684e2e",
      borderIdle: "#3d2e1b",
      hint: "#e8b04a",
      lane: "#c98bde",
      pullRequest: "#e8b04a",
      sectionLabel: "#8a7448",
      selection: "#59431c",
      selectionInk: "#ffd786",
      stripe: "#281d12",
      surface: "#2e2214",
      textBright: "#e3cfa2",
      textDim: "#8a7d68",
      textMuted: "#a08a5f",
      textPrimary: "#e3cfa2",
      textSecondary: "#c1ac80",
      warn: "#c9973f",
    });
  });

  test("speaks quest-log grammar: ! available, ⚔ out on the job, ? returned, ! dimmed for blocked", () => {
    expect(TAVERN_THEME.status.ready).toEqual({ color: "#ffd100", glyph: "!", label: "ready" });
    expect(TAVERN_THEME.status.accepted).toEqual({
      color: "#e8b04a",
      glyph: "⚔",
      label: "active",
    });
    expect(TAVERN_THEME.status.turned_in).toEqual({
      color: "#ffd100",
      glyph: "?",
      label: "review",
    });
    expect(TAVERN_THEME.blockedStatus).toEqual({ glyph: "!", label: "blocked" });
    expect(TAVERN_THEME.status.complete).toEqual({
      color: "#a08a5f",
      glyph: "✓",
      label: "complete",
    });
  });

  test("wears item-quality priority ink", () => {
    expect(TAVERN_THEME.priorityInk).toEqual({ 1: "#ff8000", 2: "#2f8be6", 3: "#1eff00" });
  });

  test("gives every state a mark of its own", () => {
    const glyphs = [
      ...Object.values(TAVERN_THEME.status).map((status) => status.glyph),
      TAVERN_THEME.blockedStatus.glyph,
    ];
    // ready and blocked share ! on purpose — same quest, dimmed because you cannot take it yet.
    const distinct = glyphs.filter((glyph) => glyph !== "!");
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  test("every status glyph occupies exactly one terminal cell", () => {
    const glyphs = [
      ...Object.values(TAVERN_THEME.status).map((status) => status.glyph),
      TAVERN_THEME.blockedStatus.glyph,
    ];
    for (const glyph of glyphs) {
      expect(stringWidth(glyph)).toBe(1);
    }
  });

  test("leaves the columns exactly where dense puts them", () => {
    for (const status of Object.keys(DENSE_THEME.status) as (keyof typeof DENSE_THEME.status)[]) {
      expect(stringWidth(questStatusText(TAVERN_THEME.status[status]))).toBe(
        stringWidth(questStatusText(DENSE_THEME.status[status])),
      );
    }
    expect(stringWidth(TAVERN_THEME.blockedStatus.label)).toBe(
      stringWidth(DENSE_THEME.blockedStatus.label),
    );
  });

  test("changes nothing but palette and glyphs", () => {
    expect(TAVERN_THEME.glyphs).toEqual(DENSE_THEME.glyphs);
    expect(TAVERN_THEME.labels).toEqual(DENSE_THEME.labels);
    expect(TAVERN_THEME.structure).toEqual(DENSE_THEME.structure);
    expect(TAVERN_THEME.border).toBe(DENSE_THEME.border);
  });
});

describe("priority ink", () => {
  test("gives each level its own color", () => {
    expect(questPriorityInk(TAVERN_THEME, 1)).toBe("#ff8000");
    expect(questPriorityInk(TAVERN_THEME, 2)).toBe("#2f8be6");
    expect(questPriorityInk(TAVERN_THEME, 3)).toBe("#1eff00");
  });

  test("renders a priority the schema forbids as the lowest one", () => {
    expect(questPriorityInk(TAVERN_THEME, 9)).toBe("#1eff00");
  });
});
