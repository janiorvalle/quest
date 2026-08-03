import { describe, expect, test } from "bun:test";

import { DENSE_THEME, type QuestTheme } from "./theme";
import { createThemeSaver } from "./theme-saver";

const FIRST: QuestTheme = { ...DENSE_THEME, name: "test-first" };
const SECOND: QuestTheme = { ...DENSE_THEME, name: "test-second" };

interface Recorded {
  readonly failed: string[];
  readonly saved: string[];
  readonly writes: string[];
}

function saverWithGate() {
  const recorded: Recorded = { failed: [], saved: [], writes: [] };
  const gates: (() => void)[] = [];
  const request = createThemeSaver({
    onFailed: (theme, reason) => {
      recorded.failed.push(`${theme.name}: ${reason}`);
    },
    onSaved: (theme) => {
      recorded.saved.push(theme.name);
    },
    save: (themeName) => {
      recorded.writes.push(themeName);
      return new Promise<void>((resolve) => {
        gates.push(resolve);
      });
    },
  });
  const releaseNextWrite = async () => {
    gates.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { recorded, releaseNextWrite, request };
}

describe("theme saver", () => {
  test("reports the write once it lands", async () => {
    const { recorded, releaseNextWrite, request } = saverWithGate();

    request(FIRST);
    expect(recorded.writes).toEqual(["test-first"]);
    expect(recorded.saved).toEqual([]);

    await releaseNextWrite();
    expect(recorded.saved).toEqual(["test-first"]);
  });

  test("never runs two writes at once and lets the newest choice win", async () => {
    const { recorded, releaseNextWrite, request } = saverWithGate();

    request(FIRST);
    request(SECOND);
    request(FIRST);
    // The first write is still in flight, so the two later presses have not queued writes of
    // their own; they collapsed into one follow-up for the theme actually on screen.
    expect(recorded.writes).toEqual(["test-first"]);

    await releaseNextWrite();
    expect(recorded.writes).toEqual(["test-first", "test-first"]);
    // Only the newest request narrates, so the superseded first press stays silent.
    expect(recorded.saved).toEqual([]);

    await releaseNextWrite();
    expect(recorded.writes).toEqual(["test-first", "test-first"]);
    expect(recorded.saved).toEqual(["test-first"]);
  });

  test("a settled older attempt at the same theme does not narrate a newer one", async () => {
    const { recorded, releaseNextWrite, request } = saverWithGate();

    request(FIRST);
    request(FIRST);
    await releaseNextWrite();
    expect(recorded.saved).toEqual([]);

    await releaseNextWrite();
    expect(recorded.saved).toEqual(["test-first"]);
  });

  test("a failed write reports why and does not wedge later saves", async () => {
    const recorded: Recorded = { failed: [], saved: [], writes: [] };
    let failNext = true;
    const request = createThemeSaver({
      onFailed: (theme, reason) => {
        recorded.failed.push(`${theme.name}: ${reason}`);
      },
      onSaved: (theme) => {
        recorded.saved.push(theme.name);
      },
      save: (themeName) => {
        recorded.writes.push(themeName);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("config file is read-only"));
        }
        return Promise.resolve();
      },
    });

    request(FIRST);
    await Promise.resolve();
    await Promise.resolve();
    expect(recorded.failed).toEqual(["test-first: config file is read-only"]);

    request(SECOND);
    await Promise.resolve();
    await Promise.resolve();
    expect(recorded.saved).toEqual(["test-second"]);
  });
});
