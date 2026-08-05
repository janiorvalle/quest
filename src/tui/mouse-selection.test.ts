import { describe, expect, test } from "bun:test";

import { InvalidTuiMouseError, selectQuestMouse } from "./mouse-selection";

describe("viewer mouse selection precedence", () => {
  test("enables mouse tracking by default", () => {
    expect(selectQuestMouse({})).toBe(true);
  });

  test("reads the config preference", () => {
    expect(selectQuestMouse({ configMouse: false })).toBe(false);
    expect(selectQuestMouse({ configMouse: true })).toBe(true);
  });

  test("lets the environment override config", () => {
    expect(selectQuestMouse({ configMouse: true, environmentMouse: "false" })).toBe(false);
    expect(selectQuestMouse({ configMouse: false, environmentMouse: "true" })).toBe(true);
  });

  test("rejects an invalid environment value with a corrected example", () => {
    expect(() => selectQuestMouse({ environmentMouse: "off" })).toThrow(InvalidTuiMouseError);
    expect(() => selectQuestMouse({ environmentMouse: "off" })).toThrow("QUEST_TUI_MOUSE=false");
  });
});
