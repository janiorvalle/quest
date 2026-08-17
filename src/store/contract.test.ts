import { describe, expect, test } from "bun:test";

import type {
  Chain,
  Event,
  EventFilter,
  Evidence,
  NewEvidence,
  NewQuest,
  Quest,
  QuestDump,
  QuestFilter,
  QuestStats,
  QuestTransition,
  Sha256,
} from "../schema";
import { STORE_SCHEMA_VERSION } from "../schema";
import {
  type BlobStoreFactory,
  inspectBlobStoreContract,
  inspectQuestStoreContract,
  type QuestStoreFactory,
  type QuestStoreHarness,
} from "./contract";
import type { BlobStore, QuestStore } from "./port";

const timestamp = "2026-07-29T00:00:00Z";

describe("QuestStore contract suite", () => {
  test("fails meaningfully against a deliberately nonconforming stub", async () => {
    const failures = await inspectQuestStoreContract(nonconformingFactory);

    expect(failures.map((failure) => failure.scenario)).toEqual([
      "claim races have exactly one winner",
      "illegal transitions change neither state nor events",
      "sign-off requires completion and appends repeat attestations",
      "sign-off batches commit attestations and evidence atomically",
      "chain invariants are enforced inside the write boundary",
      "backfilled adds enforce kind and verdict validity",
      "events and state changes commit together",
      "event queries support every individual filter",
      "event queries compose filters",
      "event query ranges include offset-equivalent endpoints",
      "event query ID cursors return only newer events",
      "event queries return events in stable ID order",
      "display IDs are unique and monotonic",
      "exportAll survives a schema-validated JSON round trip",
      "watch registration and unsubscribe honor snapshot semantics",
    ]);
    for (const failure of failures) {
      expect(failure.message).toStartWith("Store contract:");
    }
  });

  test("fails meaningfully against a nonconforming blob stub", async () => {
    const failures = await inspectBlobStoreContract(nonconformingBlobFactory);

    expect(failures.map((failure) => failure.scenario)).toEqual([
      "put is content-addressed and idempotent",
      "failed publication leaves no readable blob",
    ]);
    for (const failure of failures) {
      expect(failure.message).toStartWith("Store contract:");
    }
  });
});

const nonconformingFactory: QuestStoreFactory = async (): Promise<QuestStoreHarness> => {
  let quests: Quest[] = [];
  const chains: Chain[] = [];
  const evidence: Evidence[] = [];

  const findQuest = (id: number): Quest => {
    const quest = quests.find((candidate) => candidate.id === id);
    if (quest === undefined) {
      throw new Error(`missing quest ${id}`);
    }
    return quest;
  };

  const store = {
    async addQuest(input: NewQuest): Promise<Quest> {
      const quest = {
        ...input,
        id: 1,
        lease_expires_at: input.lease_expires_at ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      } satisfies Quest;
      quests.push(quest);
      return quest;
    },

    async acceptQuest(input): ReturnType<QuestStore["acceptQuest"]> {
      const quest = findQuest(input.id);
      const updated = {
        ...quest,
        assignee: input.owner,
        status: "accepted",
      } satisfies Quest;
      quests = quests.map((candidate) => (candidate.id === input.id ? updated : candidate));
      return {
        outcome: "accepted",
        lease_expires_at: updated.lease_expires_at,
        quest: updated,
      };
    },

    async acceptQuestAndDetail(input): ReturnType<QuestStore["acceptQuestAndDetail"]> {
      const acceptance = await store.acceptQuest(input);
      return { acceptance, detail: await store.readQuestDetail(input.id) };
    },

    async touchQuest(input): ReturnType<QuestStore["touchQuest"]> {
      return findQuest(input.id);
    },

    async transition(id: number, _transition: QuestTransition): Promise<Quest> {
      return findQuest(id);
    },

    async signoffBatch(input): ReturnType<QuestStore["signoffBatch"]> {
      return { quests: input.ids.map(findQuest), evidence: [] };
    },

    async addChainLink(input): ReturnType<QuestStore["addChainLink"]> {
      chains.push(input.link);
      return { outcome: "added", link: input.link };
    },

    async removeChainLink(input): ReturnType<QuestStore["removeChainLink"]> {
      const index = chains.findIndex(
        (link) =>
          link.quest_id === input.link.quest_id &&
          link.target_id === input.link.target_id &&
          link.type === input.link.type,
      );
      if (index < 0) {
        return { outcome: "missing", link: input.link };
      }
      chains.splice(index, 1);
      return { outcome: "removed", link: input.link };
    },

    async addEvidence(input: NewEvidence): Promise<Evidence> {
      const item = {
        ...input,
        id: 1,
        created_at: timestamp,
      } satisfies Evidence;
      evidence.push(item);
      return item;
    },

    async listQuests(_filter: QuestFilter): Promise<Quest[]> {
      return [...quests];
    },

    async getQuest(id: number): Promise<Quest | null> {
      return quests.find((quest) => quest.id === id) ?? null;
    },

    async readQuestDetail(id): ReturnType<QuestStore["readQuestDetail"]> {
      return Promise.reject(new Error(`detail unavailable for quest ${id}`));
    },

    async stats(): Promise<QuestStats> {
      return { repos: [] };
    },

    async events(_questId: number): Promise<Event[]> {
      return [];
    },

    async queryEvents(_filter: EventFilter): Promise<Event[]> {
      return [];
    },

    async exportAll(): Promise<QuestDump> {
      return {
        schema_version: STORE_SCHEMA_VERSION,
        quests: [...quests],
        evidence: [...evidence],
        chains: [...chains],
        events: [],
      };
    },

    async watch(_filter, _listener): ReturnType<QuestStore["watch"]> {
      return { unsubscribe: async () => {} };
    },
  } satisfies QuestStore;

  return {
    store,
    failNextEventAppend: async () => {},
    flushWatch: async () => {},
    close: async () => {},
  };
};

const nonconformingBlobFactory: BlobStoreFactory = async () => {
  const store = {
    async put(_bytes: Uint8Array): Promise<Sha256> {
      return "0".repeat(64);
    },

    async get(_sha256: Sha256): Promise<Uint8Array | null> {
      return null;
    },

    async has(_sha256: Sha256): Promise<boolean> {
      return false;
    },
  } satisfies BlobStore;

  return {
    store,
    failNextPublish: async () => {},
    close: async () => {},
  };
};
