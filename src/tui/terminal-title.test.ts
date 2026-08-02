import { describe, expect, test } from "bun:test";

import {
  createTerminalTitleController,
  terminalTitleForSnapshot,
  terminalTitleSequence,
} from "./terminal-title";
import { prepareTmuxPassthrough } from "./tmux";

describe("terminal title", () => {
  test("formats repository and federated scopes", () => {
    expect(terminalTitleForSnapshot({ currentRepo: "quest", scope: "current" })).toBe(
      "quest \u00b7 quest",
    );
    expect(terminalTitleForSnapshot({ currentRepo: null, scope: "all" })).toBe("quest \u00b7 all");
  });

  test("emits launch, scope changes, and one clear sequence", () => {
    const sequences: string[] = [];
    const controller = createTerminalTitleController({
      isSupported: () => true,
      write: (sequence) => sequences.push(sequence),
    });

    controller.update({ currentRepo: "quest", scope: "current" });
    controller.update({ currentRepo: "quest", scope: "current" });
    controller.update({ currentRepo: null, scope: "all" });
    controller.clear();
    controller.clear();

    expect(sequences).toEqual([
      terminalTitleSequence("quest \u00b7 quest"),
      terminalTitleSequence("quest \u00b7 all"),
      terminalTitleSequence(""),
    ]);
  });

  test("does not write terminal controls when the output is unsupported", () => {
    const sequences: string[] = [];
    const controller = createTerminalTitleController({
      isSupported: () => false,
      write: (sequence) => sequences.push(sequence),
    });

    controller.update({ currentRepo: "quest", scope: "current" });
    controller.clear();

    expect(sequences).toEqual([]);
  });

  test("does not clear a title it did not set", () => {
    const sequences: string[] = [];
    const controller = createTerminalTitleController({
      isSupported: () => true,
      write: (sequence) => sequences.push(sequence),
    });

    controller.clear();

    expect(sequences).toEqual([]);
  });

  test("wraps title controls for tmux passthrough", () => {
    expect(terminalTitleSequence("quest \u00b7 repo", { tmuxPassthrough: true })).toBe(
      "\u001bPtmux;\u001b\u001b]0;quest \u00b7 repo\u0007\u001b\\",
    );
  });

  test("removes control characters from scope names", () => {
    expect(
      terminalTitleForSnapshot({ currentRepo: "quest\u001b[31m\u009b", scope: "current" }),
    ).toBe("quest \u00b7 quest[31m");
  });
});

describe("tmux passthrough setup", () => {
  test("enables the current pane and restores an inherited setting", async () => {
    const calls: string[][] = [];
    const setup = await prepareTmuxPassthrough({
      environment: { TMUX: "server", TMUX_PANE: "%0" },
      run: async (argumentsList) => {
        calls.push([...argumentsList]);
        return "";
      },
    });

    expect(setup.enabled).toBeTrue();
    await setup.restore();
    await setup.restore();
    expect(calls).toEqual([
      ["show-options", "-p", "-qv", "-t", "%0", "allow-passthrough"],
      ["set-option", "-p", "-t", "%0", "allow-passthrough", "on"],
      ["set-option", "-p", "-u", "-t", "%0", "allow-passthrough"],
    ]);
  });

  test("restores an explicit pane setting", async () => {
    const calls: string[][] = [];
    const setup = await prepareTmuxPassthrough({
      environment: { TMUX: "server", TMUX_PANE: "%1" },
      run: async (argumentsList) => {
        calls.push([...argumentsList]);
        return calls.length === 1 ? "off\n" : "";
      },
    });

    await setup.restore();
    expect(calls[2]).toEqual(["set-option", "-p", "-t", "%1", "allow-passthrough", "off"]);
  });

  test("restores the all-pane setting", async () => {
    const calls: string[][] = [];
    const setup = await prepareTmuxPassthrough({
      environment: { TMUX: "server", TMUX_PANE: "%2" },
      run: async (argumentsList) => {
        calls.push([...argumentsList]);
        return calls.length === 1 ? "all\n" : "";
      },
    });

    await setup.restore();
    expect(calls[2]).toEqual(["set-option", "-p", "-t", "%2", "allow-passthrough", "all"]);
  });

  test("does nothing outside tmux", async () => {
    const calls: string[][] = [];
    const setup = await prepareTmuxPassthrough({
      environment: {},
      run: async (argumentsList) => {
        calls.push([...argumentsList]);
        return "";
      },
    });

    await setup.restore();
    expect(setup.enabled).toBeFalse();
    expect(calls).toEqual([]);
  });
});
