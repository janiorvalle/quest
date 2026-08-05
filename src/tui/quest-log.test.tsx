import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import {
  EMPTY_QUEST_LOG_SIGNOFF,
  type QuestLogItem,
  type QuestLogRuntime,
  type QuestLogSnapshot,
} from "../services/quest-log-model";
import { QuestLogApp } from "./quest-log";

function item(id: number, title: string): QuestLogItem {
  return {
    area: "tui",
    assignee: null,
    blocked: false,
    description: `${title} ${"detail content ".repeat(80)}`,
    id,
    kind: "task",
    openedBy: "janiorvalle",
    predictedFiles: [],
    pr: null,
    prState: null,
    priority: 2,
    repo: "quest",
    status: "ready",
    title,
    updatedAt: "2026-08-05T20:00:00.000Z",
  };
}

const ALPHA = item(1, "Alpha wheel target");
const BETA = item(2, "Beta wheel target");
const SNAPSHOT: QuestLogSnapshot = {
  currentRepo: "quest",
  error: null,
  items: [ALPHA, BETA],
  loading: false,
  plan: null,
  refreshing: false,
  signoff: {
    ...EMPTY_QUEST_LOG_SIGNOFF,
    awaitingCount: 2,
    groups: [
      {
        group: 1,
        ids: [1, 2],
        items: [ALPHA, BETA],
        label: "ready for sign-off",
        oldestAt: "2026-08-05T20:00:00.000Z",
        reason: "area",
        repo: "quest",
        why: "same pull request",
      },
    ],
  },
  scope: "current",
};

function runtimeFor(snapshot: QuestLogSnapshot): QuestLogRuntime {
  return {
    cycleScope: () => Promise.resolve({ currentRepo: "quest", scope: "current" }),
    loadDetail: () => new Promise(() => {}),
    openEvidence: () => Promise.resolve("opened"),
    openPr: () => Promise.resolve("opened"),
    pollIntervalMs: 60_000,
    setSignoffActive: () => {},
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    subscribe: (listener) => {
      listener(snapshot);
      return () => {};
    },
  };
}

function paneText(frame: string, startColumn: number): string {
  return frame
    .split("\n")
    .map((line) => line.slice(startColumn))
    .join("\n");
}

test("routes wheel events by hovered pane and ignores clicks", async () => {
  const width = 120;
  const listWidth = Math.floor(width * 0.57);
  const setup = await testRender(
    <QuestLogApp
      runtime={runtimeFor(SNAPSHOT)}
      theme={{ name: "dense", save: () => Promise.resolve(), warnings: [] }}
    />,
    { height: 32, useMouse: true, width },
  );

  try {
    const initial = await setup.waitForFrame((frame) =>
      paneText(frame, listWidth + 1).includes(ALPHA.title),
    );

    await act(async () => setup.mockMouse.click(5, 8));
    await setup.flush();
    expect(paneText(setup.captureCharFrame(), listWidth + 1)).toContain(ALPHA.title);
    expect(setup.renderer.hasSelection).toBe(false);

    await act(async () => setup.mockMouse.drag(5, 8, 30, 8));
    expect(setup.renderer.hasSelection).toBe(false);

    await act(async () => setup.mockMouse.scroll(5, 8, "down"));
    const selectedBeta = await setup.waitForFrame((frame) =>
      paneText(frame, listWidth + 1).includes(BETA.title),
    );
    expect(selectedBeta).not.toBe(initial);

    const detailBefore = paneText(selectedBeta, listWidth + 1);
    await act(async () => setup.mockMouse.scroll(listWidth + 8, 8, "down"));
    const detailAfter = await setup.waitForFrame(
      (frame) => paneText(frame, listWidth + 1) !== detailBefore,
    );
    expect(paneText(detailAfter, 0)).toContain("Beta wheel target");

    act(() => setup.mockInput.pressKey("g"));
    await setup.waitForFrame((frame) => frame.includes("lens sign-off"));
    await act(async () => setup.mockMouse.scroll(5, 8, "down"));
    await setup.waitForFrame((frame) => paneText(frame, listWidth + 1).includes(BETA.title));
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("ignores injected wheel events when terminal mouse tracking is disabled", async () => {
  const width = 120;
  const listWidth = Math.floor(width * 0.57);
  const setup = await testRender(
    <QuestLogApp
      runtime={runtimeFor(SNAPSHOT)}
      theme={{ name: "dense", save: () => Promise.resolve(), warnings: [] }}
    />,
    { height: 32, useMouse: false, width },
  );

  try {
    await setup.waitForFrame((frame) => paneText(frame, listWidth + 1).includes(ALPHA.title));
    expect(setup.renderer.useMouse).toBe(false);

    await act(async () => setup.mockMouse.scroll(5, 8, "down"));
    await setup.flush();

    expect(paneText(setup.captureCharFrame(), listWidth + 1)).toContain(ALPHA.title);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
