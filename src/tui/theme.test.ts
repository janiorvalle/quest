import { describe, expect, test } from "bun:test";

import { DENSE_THEME, QUEST_THEMES, themeByName } from "./theme";

describe("dense theme", () => {
  test("is the default and only shipped theme", () => {
    expect(QUEST_THEMES).toEqual([DENSE_THEME]);
    expect(themeByName(undefined)).toBe(DENSE_THEME);
    expect(themeByName("missing")).toBe(DENSE_THEME);
    expect(themeByName("dense")).toBe(DENSE_THEME);
  });

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
