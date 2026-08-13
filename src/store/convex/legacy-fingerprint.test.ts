import { describe, expect, test } from "bun:test";

import { questDumpSchema } from "../../schema";
import { legacyReadySnapshot } from "./legacy-fingerprint";

const quest = {
  id: 1,
  repo: "quest",
  area: null,
  kind: "task" as const,
  title: "Unified status",
  description: "",
  opened_by: "test",
  guild: null,
  assignee: null,
  status: "open" as const,
  verdict: null,
  verdict_notes: null,
  priority: 2,
  pr: null,
  predicted_files: [],
  reopen_count: 0,
  lease_expires_at: null,
  created_at: "2026-08-13T00:00:00.000Z",
  updated_at: "2026-08-13T00:00:00.000Z",
};

describe("legacy Convex recovery fingerprints", () => {
  test("recreates the v9 schema and ready statuses without changing event history", () => {
    const event = {
      id: 1,
      quest_id: 1,
      at: quest.created_at,
      actor: "test",
      action: "add" as const,
      detail: { status: "ready" },
    };
    const current = questDumpSchema.parse({
      schema_version: 10,
      quests: [quest, { ...quest, id: 2, kind: "bug", verdict: "actionable" }],
      evidence: [],
      chains: [],
      events: [event],
    });

    const legacy = legacyReadySnapshot(current);

    expect(legacy.schema_version).toBe(9);
    expect(legacy.quests.map(({ status }) => status)).toEqual(["ready", "ready"]);
    expect(legacy.events).toEqual([event]);
  });

  test("keeps non-actionable bugs open", () => {
    const current = questDumpSchema.parse({
      schema_version: 10,
      quests: [{ ...quest, kind: "bug" }],
      evidence: [],
      chains: [],
      events: [],
    });

    expect(legacyReadySnapshot(current).quests[0]?.status).toBe("open");
  });
});
