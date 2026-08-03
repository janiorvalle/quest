import { describe, expect, test } from "bun:test";
import { stringWidth } from "bun";

import type { QuestLogDetail, QuestLogEventEntry, QuestLogItem } from "../services/quest-log-model";
import {
  blockedStatusText,
  buildDetailDocument,
  buildDetailLayout,
  detailPaneScrollMetrics,
  laneConflictLinesFor,
  laneMarkerFor,
  pullRequestGlyphColor,
  sessionAttributionText,
  wrapText,
} from "./components";
import { DENSE_THEME, TAVERN_THEME } from "./theme";

const item: QuestLogItem = {
  area: "cli",
  assignee: "janiorvalle",
  blocked: false,
  description:
    "Found during verification. Server-side errors reach the terminal wrapper and the viewer should retain the complete explanation instead of inventing a character limit.",
  id: 95,
  kind: "bug",
  openedBy: "janiorvalle",
  predictedFiles: [
    "src/store/convex/client.ts",
    "evidence/094-convex-error-normalization/VERIFICATION.md",
  ],
  pr: null,
  prState: null,
  priority: 2,
  repo: "quest",
  status: "accepted",
  title: "Viewer right pane truncates content while most of the pane sits empty",
  updatedAt: "2026-08-01T02:17:00.000Z",
};

const events: readonly QuestLogEventEntry[] = [
  {
    action: "accept",
    actor: "janiorvalle",
    at: "2026-08-01T01:11:00.000Z",
    detailSummary: "assignee janiorvalle · lease expires at 2026-08-01T01:41:00.000Z",
    id: 2,
  },
  {
    action: "add",
    actor: "janiorvalle",
    at: "2026-08-01T01:07:00.000Z",
    detailSummary: "repo quest · area cli",
    id: 1,
  },
];

const detail: QuestLogDetail = {
  duplicateOf: [],
  events,
  evidence: [
    {
      actor: "janiorvalle",
      filename: "viewer-right-pane-truncation.png",
      id: 10,
      kind: "screenshot",
      stage: "report",
    },
  ],
  questId: 95,
  requiredBy: [],
  requires: [
    {
      assignee: null,
      id: 94,
      status: "complete",
      title: "Normalize server errors before they reach the terminal wrapper",
    },
  ],
  sessionAttribution: null,
};

describe("detail pane layout", () => {
  test("formats only the session attribution fields that are present", () => {
    expect(sessionAttributionText({ effort: "max", guild: "claude", model: "fable-5" })).toBe(
      "guild claude · fable-5 · max",
    );
    expect(sessionAttributionText({ guild: "claude" })).toBe("guild claude");
    expect(sessionAttributionText({ effort: "max", model: "fable-5" })).toBe("fable-5 · max");
    expect(sessionAttributionText(null)).toBeNull();
  });

  test("wraps words and long tokens without dropping content", () => {
    const lines = wrapText("alpha beta evidence/094-convex-error-normalization", 12);

    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.join(" ").replaceAll(" ", "")).toContain(
      `alphabeta${"evidence/094-convex-error-normalization".replaceAll(" ", "")}`,
    );

    const unicodeValue = "東京🙂é";
    const unicodeLines = wrapText(unicodeValue, 4);
    expect(unicodeLines.every((line) => stringWidth(line) <= 4)).toBe(true);
    expect(unicodeLines.join("")).toBe(unicodeValue);
    const narrowUnicodeLines = wrapText("界🙂", 1);
    expect(narrowUnicodeLines.every((line) => stringWidth(line) <= 1)).toBe(true);

    const boundaryPath = `${"a".repeat(78)}/tail`;
    const boundaryLayout = buildDetailLayout(
      { ...item, predictedFiles: [boundaryPath] },
      detail,
      92,
      32,
    );
    const boundaryLines = boundaryLayout.fileBlocks.flatMap((block) =>
      block.lines.map((line) => line.text),
    );
    expect(boundaryLines.every((line) => stringWidth(line) <= 90)).toBe(true);
    expect(boundaryLines.join("").replaceAll(" ", "")).toContain(boundaryPath);
  });

  test("keeps full paths, descriptions, relationship labels, and event tails in a wide pane", () => {
    const layout = buildDetailLayout(item, detail, 92, 32);
    const fileText = layout.fileBlocks
      .flatMap((block) => block.lines.map((line) => line.text))
      .join("\n");
    const descriptionText = layout.descriptionLines.map((line) => line.text).join(" ");
    const chainText = layout.chainRows.map((row) => row.body).join(" ");
    const activityText = layout.activityRows
      .map((row) => `${row.timestamp} ${row.label} ${row.detail ?? ""}`)
      .join(" ");

    expect(fileText).toContain("src/store/convex/client.ts");
    expect(fileText).toContain("evidence/094-convex-error-normalization/VERIFICATION.md");
    expect(descriptionText).toContain("complete explanation");
    expect(chainText).toContain("requires");
    expect(activityText.replace(/\s+/g, " ")).toContain(
      "lease expires at 2026-08-01T01:41:00.000Z",
    );
    expect(layout.descriptionBodyRows).toBe(layout.descriptionLines.length);
    expect(layout.laneConflictLines).toEqual([]);
    expect(layout.usedRows).toBeLessThan(32);
  });

  test("keeps the full document available when the viewport is short", () => {
    const layout = buildDetailLayout(item, detail, 56, 15);
    const veryShortLayout = buildDetailLayout(item, detail, 56, 10);
    const document = buildDetailDocument(item, detail, 56);
    const metrics = detailPaneScrollMetrics(item, detail, 56, 15);

    expect(layout.usedRows).toBeGreaterThan(15);
    expect(layout.descriptionLines.at(-1)?.text).toBe("limit.");
    expect(layout.activityRows[0]?.timestamp).toBe("01:11");
    expect(
      layout.fileBlocks.flatMap((block) => block.lines.map((line) => line.text)).join("\n"),
    ).toContain("src/store/convex/client.ts");
    expect(veryShortLayout.usedRows).toBeGreaterThan(10);
    expect(veryShortLayout.descriptionLines.at(-1)?.text).toBe("limit.");
    const documentActivity = document.lines
      .filter((line) => line.kind === "activity")
      .map((line) => `${line.row.timestamp} ${line.row.label} ${line.row.detail ?? ""}`)
      .join(" ");
    expect(documentActivity).toContain("lease expires at");
    expect(documentActivity).toContain("2026-08-01T01:41:00.000Z");
    expect(metrics.contentRows).toBe(document.lines.length);
    expect(metrics.viewportRows).toBe(8);
    expect(metrics.maxOffset).toBe(metrics.contentRows - metrics.viewportRows);
  });

  test("keeps crowded event details and tiny row budgets honest", () => {
    const firstEvent = events.at(0);
    if (firstEvent === undefined) {
      throw new Error("event fixture is empty");
    }
    const crowdedDetail: QuestLogDetail = {
      ...detail,
      events: [
        {
          ...firstEvent,
          action: "very-long-action",
          actor: "very-long-actor",
        },
      ],
    };
    const crowdedRows = buildDetailLayout(item, crowdedDetail, 22, 64).activityRows;

    expect(
      crowdedRows.some(
        (row) => row.continuation && (row.detail?.includes("lease expires") ?? false),
      ),
    ).toBe(true);

    for (const rowBudget of [1, 2, 3, 4, 5, 6, 7]) {
      const layout = buildDetailLayout(item, detail, 56, rowBudget);
      expect(layout.headerRows).toBeLessThanOrEqual(rowBudget);
      expect(layout.descriptionLines.length).toBeGreaterThan(0);
      expect(layout.usedRows).toBeGreaterThan(rowBudget);
    }
  });
});

describe("plan list annotations", () => {
  const items: readonly QuestLogItem[] = [
    { ...item, computedState: "dispatchable", id: 87 },
    {
      ...item,
      blocked: true,
      blockerId: 87,
      chainDepth: 1,
      computedState: "blocked",
      id: 93,
    },
  ];
  const sharedFiles = [
    {
      area: null,
      files: ["src/tui/quest-log.tsx"],
      heuristic: false,
      kind: "shared_files",
      quest_ids: [87, 93],
    },
  ] as const;
  const [dispatchable, blocked] = items;
  if (dispatchable === undefined || blocked === undefined) {
    throw new Error("plan list fixture is incomplete");
  }

  test("labels a blocked row with its nearest blocker", () => {
    expect(blockedStatusText(DENSE_THEME, blocked)).toBe("○ blocked 87");
    expect(blockedStatusText(DENSE_THEME, dispatchable)).toBeNull();
    expect(blockedStatusText(DENSE_THEME, { ...blocked, blockerIds: [87, 94, 95] })).toBe(
      "○ blocked 87 +2",
    );
  });

  test("takes the blocked glyph from the theme", () => {
    expect(blockedStatusText(TAVERN_THEME, blocked)).toBe("! blocked 87");
  });

  test("marks adjacent plan-lane rows with the kind and partner ids", () => {
    expect(laneMarkerFor(0, items, sharedFiles)).toEqual({
      edge: "start",
      label: "shared files",
      partnerIds: [93],
    });
    expect(laneMarkerFor(1, items, sharedFiles)).toEqual({
      edge: "end",
      label: "shared files",
      partnerIds: [87],
    });
    expect(laneMarkerFor(0, [dispatchable, { ...blocked, id: 101 }], sharedFiles)).toBeNull();
  });

  test("keeps every non-adjacent partner in the detail conflict line", () => {
    const denseClusters = [
      {
        area: null,
        files: ["TODO_TRACKER.md"],
        heuristic: false,
        kind: "shared_files",
        quest_ids: [165, 169],
      },
      {
        area: null,
        files: ["TODO_TRACKER.md"],
        heuristic: false,
        kind: "shared_files",
        quest_ids: [165, 170],
      },
      {
        area: null,
        files: ["tests/journeys/README.md"],
        heuristic: false,
        kind: "shared_files",
        quest_ids: [165, 171],
      },
    ] as const;
    const line = "conflicts: 169, 170 via TODO_TRACKER.md; 171 via tests/journeys/README.md";

    expect(
      laneMarkerFor(
        0,
        [
          { ...item, computedState: "dispatchable", id: 165 },
          { ...item, computedState: "dispatchable", id: 166 },
          { ...item, computedState: "dispatchable", id: 167 },
          { ...item, computedState: "dispatchable", id: 168 },
          { ...item, computedState: "dispatchable", id: 169 },
          { ...item, computedState: "dispatchable", id: 170 },
          { ...item, computedState: "dispatchable", id: 171 },
        ],
        denseClusters,
      ),
    ).toBeNull();
    expect(laneConflictLinesFor(165, denseClusters, 120)).toEqual([line]);

    const layout = buildDetailLayout(
      { ...item, computedState: "dispatchable", id: 165 },
      detail,
      120,
      32,
      DENSE_THEME,
      denseClusters,
    );
    expect(layout.laneConflictLines.map((entry) => entry.text)).toEqual([line]);

    for (const rowBudget of [8, 9, 10]) {
      expect(
        buildDetailLayout(
          { ...item, computedState: "dispatchable", id: 165 },
          detail,
          40,
          rowBudget,
          DENSE_THEME,
          denseClusters,
        ).laneConflictLines.length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("PR list annotations", () => {
  test("uses amber only for awaiting review and keeps merged PRs quiet", () => {
    expect(
      pullRequestGlyphColor(DENSE_THEME, { ...item, pr: "42", prState: "awaiting-review" }, false),
    ).toBe(DENSE_THEME.palette.warn);
    expect(
      pullRequestGlyphColor(DENSE_THEME, { ...item, pr: "42", prState: "merged" }, false),
    ).toBe(DENSE_THEME.palette.textDim);
    expect(pullRequestGlyphColor(DENSE_THEME, { ...item, pr: "42", prState: "quiet" }, false)).toBe(
      DENSE_THEME.palette.textDim,
    );
    expect(pullRequestGlyphColor(DENSE_THEME, item, false)).toBeNull();
    expect(
      pullRequestGlyphColor(DENSE_THEME, { ...item, pr: "42", prState: "awaiting-review" }, true),
    ).toBe(DENSE_THEME.palette.selectionInk);
  });
});
