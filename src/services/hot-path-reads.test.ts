import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEvidenceFileReader } from "../evidence";
import type { NewQuest, QuestScope } from "../schema";
import type { FederatedStoreSource, QuestStore } from "../store";
import { FederatedQuestStore, LocalBlobStore, SqliteStore } from "../store";
import { addQuestChain, showQuestChains } from "./chains";
import {
  addLifecycleQuest,
  type EvidenceAttachmentRequest,
  type LifecycleServicePorts,
  transitionLifecycleQuest,
} from "./lifecycle";
import { getNextQuest } from "./next";
import { getQuestPlan } from "./plan";

const now = "2026-08-21T12:00:00Z";
const actor = "janior";
const scope: QuestScope = { repo: "quest" };
const QUEST_COUNT = 200;
const TOGGLES_PER_QUEST = 10;

type ReadCounts = ReadonlyMap<string, number>;

interface CountedStore {
  readonly counts: ReadCounts;
  readonly store: QuestStore;
  reset(): void;
}

/** Wraps a store so every method call is tallied by name while the real store does the work. */
function countStoreCalls(store: QuestStore): CountedStore {
  const counts = new Map<string, number>();
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return (...args: unknown[]) => {
        counts.set(property, (counts.get(property) ?? 0) + 1);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { counts, store: proxy, reset: () => counts.clear() };
}

function calls(counts: ReadCounts, method: string): number {
  return counts.get(method) ?? 0;
}

function task(title: string, options: Partial<NewQuest> = {}): NewQuest {
  return {
    repo: "quest",
    area: "store",
    kind: "task",
    title,
    description: `${title} description`,
    opened_by: actor,
    assignee: null,
    status: "open",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
    lease_expires_at: null,
    backfill: false,
    ...options,
  };
}

function evidenceRequest(
  workingDirectory: string,
  paths: readonly string[],
  stage: EvidenceAttachmentRequest["stage"] = "fix",
): EvidenceAttachmentRequest {
  return { actor, paths, sessionGuild: null, stage, workingDirectory };
}

interface Harness {
  readonly counted: CountedStore;
  readonly directory: string;
  readonly ports: LifecycleServicePorts;
  readonly sqlite: SqliteStore;
  close(): Promise<void>;
}

/** Builds a store with thousands of events so a full dump is measurably the wrong read. */
async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-hot-path-reads-"));
  const sqlite = new SqliteStore(join(directory, "quest.db"), { now: () => now });
  for (let index = 1; index <= QUEST_COUNT; index += 1) {
    const quest = await sqlite.addQuest(task(`Backlog quest ${index}`));
    for (let toggle = 0; toggle < TOGGLES_PER_QUEST; toggle += 1) {
      await sqlite.acceptQuest({ id: quest.id, owner: actor, session_guild: null });
      await sqlite.transition(quest.id, { action: "abandon", actor, session_guild: null });
    }
  }
  const counted = countStoreCalls(sqlite);
  return {
    counted,
    directory,
    ports: {
      blobStore: new LocalBlobStore(join(directory, "evidence")),
      evidenceFiles: createLocalEvidenceFileReader(),
      questStore: counted.store,
    },
    sqlite,
    close: async () => {
      sqlite.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

describe("agent hot paths read only the rows they need", () => {
  test("the seeded store really holds thousands of events", async () => {
    const harness = await createHarness();
    try {
      const dump = await harness.sqlite.exportAll();
      expect(dump.quests).toHaveLength(QUEST_COUNT);
      expect(dump.events.length).toBeGreaterThan(2000);
    } finally {
      await harness.close();
    }
  });

  test("next --claim --brief reads the quests+chains list dump, never the full dump", async () => {
    const harness = await createHarness();
    try {
      const { counted } = harness;
      const result = await getNextQuest(
        counted.store,
        scope,
        actor,
        undefined,
        null,
        undefined,
        true,
      );
      expect(result.claimed).toBeTrue();
      expect(result.brief).not.toBeNull();
      expect(calls(counted.counts, "exportAll")).toBe(0);
      expect(calls(counted.counts, "readFederatedSnapshot")).toBe(1);
      expect(calls(counted.counts, "acceptQuestAndDetail")).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("add with evidence and a duplicate-of replay uses per-quest reads only", async () => {
    const harness = await createHarness();
    try {
      const { counted, directory, ports } = harness;
      const reportPath = join(directory, "report.txt");
      await writeFile(reportPath, "reproduction notes\n");
      const input = task("Brand new work item", { description: "unique enough to avoid dedup" });
      const options = {
        duplicateOf: 1,
        evidence: evidenceRequest(directory, [reportPath], "report"),
        force: false,
        sessionGuild: null,
      };

      const created = await addLifecycleQuest(ports, input, options);
      expect(created.outcome).toBe("created");
      expect(created.evidence).toHaveLength(1);
      expect(calls(counted.counts, "exportAll")).toBe(0);
      expect(calls(counted.counts, "readQuestDetail")).toBe(1);

      counted.reset();
      const replayed = await addLifecycleQuest(ports, input, options);
      expect(replayed.outcome).toBe("replayed");
      expect(replayed.warnings).toContain(
        `evidence report.txt is already attached to quest ${created.quest?.id}`,
      );
      expect(calls(counted.counts, "exportAll")).toBe(0);
      expect(calls(counted.counts, "readQuestDetail")).toBe(2);
    } finally {
      await harness.close();
    }
  });

  test("attaching several evidence files reads the quest's evidence once and dedupes within the batch", async () => {
    const harness = await createHarness();
    try {
      const { counted, directory, ports } = harness;
      const firstPath = join(directory, "first.log");
      const secondPath = join(directory, "second.log");
      await writeFile(firstPath, "first\n");
      await writeFile(secondPath, "second\n");

      const result = await transitionLifecycleQuest(
        ports,
        scope,
        1,
        undefined,
        evidenceRequest(directory, [firstPath, secondPath, firstPath]),
        {},
      );
      expect(result.changed).toBeTrue();
      expect(result.evidence).toHaveLength(3);
      expect(result.warnings).toEqual(["evidence first.log is already attached to quest 1"]);
      expect(calls(counted.counts, "exportAll")).toBe(0);
      expect(calls(counted.counts, "readQuestDetail")).toBe(1);
      expect(calls(counted.counts, "addEvidence")).toBe(2);

      const stored = await harness.sqlite.readQuestDetail(1);
      expect(stored.evidence.map((item) => item.filename)).toEqual(["first.log", "second.log"]);
    } finally {
      await harness.close();
    }
  });

  test("complete keeps the verify-evidence warning and never reads the full dump", async () => {
    const harness = await createHarness();
    try {
      const { counted, directory, ports } = harness;
      const verifyPath = join(directory, "verify.txt");
      await writeFile(verifyPath, "retest passed\n");
      const noEvidence = evidenceRequest(directory, []);
      await harness.sqlite.acceptQuest({ id: 1, owner: actor, session_guild: null });
      await harness.sqlite.acceptQuest({ id: 2, owner: actor, session_guild: null });
      for (const id of [1, 2]) {
        await transitionLifecycleQuest(
          ports,
          scope,
          id,
          { action: "turnin", actor, pr: null, session_guild: null },
          noEvidence,
          {},
        );
      }
      counted.reset();

      const withoutVerify = await transitionLifecycleQuest(
        ports,
        scope,
        1,
        { action: "complete", actor, session_guild: null },
        noEvidence,
        {},
      );
      expect(withoutVerify.quest.status).toBe("complete");
      expect(withoutVerify.warnings).toEqual([
        "quest 1 has no verify-stage evidence; attach evidence with --evidence <path>",
      ]);

      const withVerify = await transitionLifecycleQuest(
        ports,
        scope,
        2,
        { action: "complete", actor, session_guild: null },
        evidenceRequest(directory, [verifyPath], "verify"),
        {},
      );
      expect(withVerify.quest.status).toBe("complete");
      expect(withVerify.warnings).toEqual([]);

      expect(calls(counted.counts, "exportAll")).toBe(0);
      expect(calls(counted.counts, "readQuestDetail")).toBe(3);
    } finally {
      await harness.close();
    }
  });

  test("chain add and chain show never read the full dump", async () => {
    const harness = await createHarness();
    try {
      const { counted } = harness;
      const added = await addQuestChain(
        counted.store,
        scope,
        { quest_id: 2, target_id: 1, type: "requires" },
        actor,
      );
      expect(added.outcome).toBe("added");
      const tree = await showQuestChains(counted.store, scope, 2);
      expect(tree.trees[0]?.lines.map((line) => line.quest.id)).toEqual([2, 1]);

      expect(calls(counted.counts, "exportAll")).toBe(0);
      expect(calls(counted.counts, "readFederatedSnapshot")).toBe(1);
    } finally {
      await harness.close();
    }
  });
});

describe("federated reads stay on the list snapshot", () => {
  test("next, chain show, and plan through FederatedQuestStore never fan out to full snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-hot-path-federated-"));
    const questStore = new SqliteStore(join(directory, "remote.db"), { now: () => now });
    let fullSnapshotReads = 0;
    let listSnapshotReads = 0;
    try {
      const first = await questStore.addQuest(task("Remote first"));
      const second = await questStore.addQuest(task("Remote second"));
      await questStore.addChainLink({
        actor,
        link: { quest_id: second.id, target_id: first.id, type: "requires" },
      });
      const source: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(directory, "remote-evidence")),
        includeRepository: (repo) => repo === "quest",
        questStore,
        readFullSnapshot: async () => {
          fullSnapshotReads += 1;
          return questStore.readFederatedFullSnapshot();
        },
        readSnapshot: async () => {
          listSnapshotReads += 1;
          return questStore.readFederatedSnapshot();
        },
      };
      const federated = new FederatedQuestStore([source]);

      const next = await getNextQuest(federated, { repo: null }, null);
      expect(next.quest?.id).toBe(first.id);
      const chains = await showQuestChains(federated, { repo: null });
      expect(chains.trees.map((tree) => tree.root_id)).toEqual([second.id]);
      const plan = await getQuestPlan(federated, { repo: null }, now);
      expect(plan.quests.map((quest) => quest.id)).toEqual([first.id, second.id]);

      expect(fullSnapshotReads).toBe(0);
      expect(listSnapshotReads).toBe(3);
    } finally {
      questStore.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
