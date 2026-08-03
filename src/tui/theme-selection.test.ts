import { describe, expect, test } from "bun:test";

import { DENSE_THEME, type QuestTheme } from "./theme";
import { selectQuestTheme, UnknownThemeError } from "./theme-selection";

const TAVERN_THEME: QuestTheme = { ...DENSE_THEME, name: "test-tavern" };
const REGISTRY: readonly QuestTheme[] = [DENSE_THEME, TAVERN_THEME];

describe("theme selection precedence", () => {
  test("falls back to dense when nothing selects a theme", () => {
    expect(selectQuestTheme({ themes: REGISTRY })).toEqual({ theme: DENSE_THEME, warnings: [] });
  });

  test("config theme wins over the built-in default", () => {
    expect(selectQuestTheme({ configTheme: "test-tavern", themes: REGISTRY }).theme).toBe(
      TAVERN_THEME,
    );
  });

  test("environment beats config", () => {
    expect(
      selectQuestTheme({
        configTheme: "test-tavern",
        environmentTheme: "dense",
        themes: REGISTRY,
      }).theme,
    ).toBe(DENSE_THEME);
  });

  test("flag beats environment and config", () => {
    expect(
      selectQuestTheme({
        configTheme: "dense",
        environmentTheme: "dense",
        flagTheme: "test-tavern",
        themes: REGISTRY,
      }).theme,
    ).toBe(TAVERN_THEME);
  });
});

describe("unknown theme names", () => {
  test("--theme fails with the valid names and a corrected command", () => {
    expect(() => selectQuestTheme({ flagTheme: "tavren", themes: REGISTRY })).toThrow(
      UnknownThemeError,
    );
    try {
      selectQuestTheme({ flagTheme: "tavren", themes: REGISTRY });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownThemeError);
      const message = (error as UnknownThemeError).message;
      expect((error as UnknownThemeError).code).toBe("QUEST_UNKNOWN_THEME");
      expect(message).toContain("[QUEST_UNKNOWN_THEME]");
      expect(message).toContain("--theme tavren");
      expect(message).toContain("Valid themes: dense, test-tavern");
      expect(message).toContain("Rerun with --theme dense");
    }
  });

  test("QUEST_THEME fails naming the variable and how to clear it", () => {
    try {
      selectQuestTheme({ environmentTheme: "ledgr", themes: REGISTRY });
      expect.unreachable();
    } catch (error) {
      const message = (error as UnknownThemeError).message;
      expect(message).toContain("QUEST_THEME=ledgr");
      expect(message).toContain("Valid themes: dense, test-tavern");
      expect(message).toContain("unset it");
    }
  });

  test("an unknown config theme warns and falls back to dense instead of failing", () => {
    const selection = selectQuestTheme({ configTheme: "from-a-newer-quest", themes: REGISTRY });
    expect(selection.theme).toBe(DENSE_THEME);
    expect(selection.warnings).toHaveLength(1);
    expect(selection.warnings[0]).toContain('Config theme "from-a-newer-quest"');
    expect(selection.warnings[0]).toContain("showing dense");
    expect(selection.warnings[0]).toContain("Press t");
  });

  // The notice strip is one line wide; a warning that overflows loses the action it asks for.
  test("the config warning fits the viewer notice strip", () => {
    const selection = selectQuestTheme({ configTheme: "from-a-newer-quest", themes: REGISTRY });
    expect(selection.warnings[0]?.length).toBeLessThanOrEqual(100);
  });

  test("a known config theme produces no warning", () => {
    expect(selectQuestTheme({ configTheme: "dense", themes: REGISTRY }).warnings).toEqual([]);
  });
});
