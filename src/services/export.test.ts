import { describe, expect, test } from "bun:test";

import type { Quest, QuestDump } from "../schema";
import { questDumpSchema, STORE_SCHEMA_VERSION } from "../schema";
import { parseQuestBackupExport, serializeQuestBackupExport } from "./export";

const timestamp = "2026-07-29T16:00:00Z";

function quest(id: number, changes: Partial<Quest>): Quest {
  return {
    id,
    repo: "alpha",
    area: "cli",
    kind: "task",
    title: `Quest ${id}`,
    description: `Description ${id}`,
    opened_by: "fixture",
    assignee: null,
    status: "ready",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
    lease_expires_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...changes,
  };
}

function fixtureDump(): QuestDump {
  const quests = [
    quest(1, {
      assignee: "amy",
      status: "complete",
      verdict: "actionable",
      title: "Complete CLI work",
    }),
    quest(2, {
      assignee: "sam",
      pr: "42",
      status: "turned_in",
      title: "Turned-in CLI work",
    }),
    quest(3, { area: "UI/UX", title: "First sanitized sheet name" }),
    quest(4, { area: "UI:UX", title: "Colliding sanitized sheet name" }),
    quest(5, { area: "store", repo: "beta", title: "Other repository" }),
    quest(6, { area: null, title: "Unassigned area" }),
  ];
  return questDumpSchema.parse({
    schema_version: STORE_SCHEMA_VERSION,
    quests,
    evidence: [
      {
        id: 1,
        quest_id: 1,
        sha256: "a".repeat(64),
        filename: "proof.png",
        kind: "screenshot",
        stage: "verify",
        added_by: "fixture",
        created_at: timestamp,
      },
    ],
    chains: [{ quest_id: 2, target_id: 1, type: "requires" }],
    events: quests.map((item) => ({
      id: item.id,
      quest_id: item.id,
      at: timestamp,
      actor: "fixture",
      action: "add",
      detail: { backfill: true },
    })),
  });
}

describe("logical backup export", () => {
  test("round-trips the complete dump through the backup restore parser", () => {
    const dump = fixtureDump();
    const restored = parseQuestBackupExport(serializeQuestBackupExport(dump));

    expect(restored).toEqual(dump);
    expect(restored.schema_version).toBe(STORE_SCHEMA_VERSION);
    expect(restored.quests).toHaveLength(6);
    expect(restored.chains).toHaveLength(1);
    expect(restored.events).toHaveLength(6);
    expect(restored.evidence).toHaveLength(1);
  });

  test("normalizes v1 logical backups by dropping branch and adding an untagged guild", () => {
    const current = fixtureDump();
    const legacy = {
      ...current,
      schema_version: 1,
      quests: current.quests.map(({ guild: _guild, lease_expires_at: _lease, ...quest }) => ({
        ...quest,
        branch: `quest/legacy/${quest.id}`,
      })),
    };

    expect(parseQuestBackupExport(JSON.stringify(legacy))).toEqual(current);
  });

  test("normalizes v2 logical backups to the current schema", () => {
    const current = fixtureDump();
    const previous = {
      ...current,
      schema_version: 2,
      quests: current.quests.map(({ lease_expires_at: _lease, ...quest }) => quest),
    };

    expect(parseQuestBackupExport(JSON.stringify(previous))).toEqual(current);
  });

  test("normalizes v3 logical backups by adding leases", () => {
    const base = fixtureDump();
    const current = questDumpSchema.parse({
      ...base,
      quests: [
        ...base.quests,
        quest(7, {
          assignee: "owner",
          status: "accepted",
          lease_expires_at: "2026-07-30T16:00:00.000Z",
        }),
      ],
      events: [
        ...base.events,
        {
          id: 7,
          quest_id: 7,
          at: timestamp,
          actor: "owner",
          action: "accept",
          detail: {},
        },
      ],
    });
    const legacy = {
      ...current,
      schema_version: 2,
      quests: current.quests.map(({ lease_expires_at: _lease, ...quest }) => quest),
    };

    expect(parseQuestBackupExport(JSON.stringify(legacy))).toEqual(current);
  });

  test("normalizes v4 logical backups after the session attribution schema bump", () => {
    const current = fixtureDump();
    const previous = { ...current, schema_version: 4 };

    expect(parseQuestBackupExport(JSON.stringify(previous))).toEqual(current);
  });

  test("normalizes v5 logical backups after the open bug dispatch schema bump", () => {
    const current = fixtureDump();
    const currentWithFederatedEvent = {
      ...current,
      events: [
        ...current.events,
        {
          id: 99,
          quest_id: 5,
          at: timestamp,
          actor: "fixture",
          action: "update" as const,
          detail: { federated: true },
          repo: "beta",
        },
      ],
    };
    const previous = { ...currentWithFederatedEvent, schema_version: 5 };

    expect(parseQuestBackupExport(JSON.stringify(previous))).toEqual(currentWithFederatedEvent);
  });

  test("normalizes v6 logical backups after the lease TTL wire schema bump", () => {
    const current = fixtureDump();
    const previous = { ...current, schema_version: 6 };

    expect(parseQuestBackupExport(JSON.stringify(previous))).toEqual(current);
  });

  test("normalizes v7 logical backups after the sign-off wire schema bump", () => {
    const current = fixtureDump();
    const previous = { ...current, schema_version: 7 };

    expect(parseQuestBackupExport(JSON.stringify(previous))).toEqual(current);
  });

  test("rejects a logical backup tagged with an unsupported schema version", () => {
    const serialized = JSON.stringify({
      ...fixtureDump(),
      schema_version: STORE_SCHEMA_VERSION + 1,
    });
    expect(() => parseQuestBackupExport(serialized)).toThrow();
  });
});
