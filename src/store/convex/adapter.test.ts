import { describe, expect, test } from "bun:test";

import {
  type Event,
  newQuestSchema,
  type QuestDump,
  questSchema,
  STORE_SCHEMA_VERSION,
} from "../../schema";
import type { FederatedReadSnapshot } from "../port";
import { ConvexStore } from "./adapter";
import { type ConvexClientPair, convexApi } from "./client";
import { QUEST_CLIENT_PROTOCOL } from "./protocol";

const timestamp = "2026-08-05T20:00:00.000Z";
const quest = newQuestSchema.parse({
  area: "tui",
  assignee: null,
  backfill: true,
  description: "Reactive watch fixture",
  guild: null,
  kind: "task",
  opened_by: "test",
  predicted_files: [],
  priority: 2,
  pr: null,
  repo: "quest",
  reopen_count: 0,
  status: "open",
  title: "Reactive watch fixture",
  verdict: null,
  verdict_notes: null,
});

interface RealtimeEntry {
  readonly args: Readonly<Record<string, unknown>>;
  readonly callback: (value: unknown) => void;
  unsubscribed: boolean;
}

function fakeClients() {
  let httpQueries = 0;
  let failNextQuery = false;
  const entries: RealtimeEntry[] = [];
  const clients = {
    http: {
      query: async (query: unknown) => {
        httpQueries += 1;
        if (failNextQuery) {
          failNextQuery = false;
          throw new Error("temporary server-time failure");
        }
        if (query === convexApi.federatedListSnapshot) {
          return {
            dump: { chains: [], quests: [], schema_version: STORE_SCHEMA_VERSION },
            fencedRepositories: [],
          };
        }
        return timestamp;
      },
    },
    realtime: {
      close: async () => undefined,
      onUpdate: (
        _query: unknown,
        args: Readonly<Record<string, unknown>>,
        callback: (value: unknown) => void,
      ) => {
        const entry = { args, callback, unsubscribed: false };
        entries.push(entry);
        return {
          unsubscribe: () => {
            entry.unsubscribed = true;
          },
        };
      },
    },
  } as unknown as ConvexClientPair;
  return {
    clients,
    entries,
    failNextQuery: () => {
      failNextQuery = true;
    },
    httpQueries: () => httpQueries,
  };
}

describe("Convex reactive watches", () => {
  test("uses websocket query results without refetching over HTTP", async () => {
    const fake = fakeClients();
    const store = new ConvexStore("http://127.0.0.1:3210", { clients: fake.clients });
    const emissions: unknown[] = [];
    let subscription: Awaited<ReturnType<ConvexStore["watch"]>> | undefined;

    try {
      subscription = await store.watch({ repo: "quest" }, (quests) => emissions.push(quests));
      expect(fake.httpQueries()).toBe(1);
      expect(fake.entries).toHaveLength(2);

      fake.entries[0]?.callback([quest]);
      fake.entries[1]?.callback([quest]);
      fake.entries[0]?.callback([]);
      expect(emissions).toEqual([[quest], []]);
      expect(fake.httpQueries()).toBe(1);

      await subscription.unsubscribe();
      subscription = undefined;
      expect(fake.entries.every((entry) => entry.unsubscribed)).toBeTrue();
    } finally {
      await subscription?.unsubscribe();
    }
  });

  test("falls back to the legacy snapshot during a rolling backend upgrade", async () => {
    const entries: RealtimeEntry[] = [];
    const fullSnapshot = {
      dump: {
        chains: [],
        events: [],
        evidence: [],
        quests: [],
        schema_version: STORE_SCHEMA_VERSION,
      },
      fencedRepositories: [],
    };
    const clients = {
      http: {
        query: async (query: unknown) => {
          if (query === convexApi.serverTime) {
            return timestamp;
          }
          if (query === convexApi.federatedListSnapshot) {
            throw new Error("[Request ID: bfdf4caebe0312d8] Server Error");
          }
          return fullSnapshot;
        },
      },
      realtime: {
        close: async () => undefined,
        onUpdate: (
          _query: unknown,
          args: Readonly<Record<string, unknown>>,
          callback: (value: unknown) => void,
        ) => {
          const entry = { args, callback, unsubscribed: false };
          entries.push(entry);
          return { unsubscribe: () => undefined };
        },
      },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });
    const emissions: unknown[] = [];
    const subscription = await store.watchFederatedSnapshot("quest", (snapshot) =>
      emissions.push(snapshot),
    );

    entries[0]?.callback(fullSnapshot);

    expect(entries[0]?.args).toEqual({ client_protocol: QUEST_CLIENT_PROTOCOL });
    expect(emissions).toEqual([
      {
        dump: { chains: [], quests: [], schema_version: STORE_SCHEMA_VERSION },
        fencedRepositories: [],
      },
    ]);
    await subscription.unsubscribe();
  });

  test("retries the list query when an ambiguous legacy probe also fails", async () => {
    let listQueries = 0;
    const listSnapshot: FederatedReadSnapshot = {
      dump: { chains: [], quests: [], schema_version: STORE_SCHEMA_VERSION },
      fencedRepositories: [],
    };
    const clients = {
      http: {
        query: async (query: unknown) => {
          if (query === convexApi.federatedListSnapshot) {
            listQueries += 1;
            if (listQueries === 1) {
              throw new Error("[Request ID: bfdf4caebe0312d8] Server Error");
            }
            return listSnapshot;
          }
          throw new Error("temporary legacy snapshot failure");
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.readFederatedSnapshot("quest")).rejects.toThrow(
      "temporary legacy snapshot failure",
    );
    expect(await store.readFederatedSnapshot("quest")).toEqual(listSnapshot);
    expect(listQueries).toBe(2);
  });

  test("does not cache an opaque server error after a successful legacy fallback", async () => {
    let listQueries = 0;
    const listSnapshot: FederatedReadSnapshot = {
      dump: { chains: [], quests: [], schema_version: STORE_SCHEMA_VERSION },
      fencedRepositories: [],
    };
    const fullSnapshot = {
      dump: {
        ...listSnapshot.dump,
        events: [],
        evidence: [],
      },
      fencedRepositories: [],
    };
    const clients = {
      http: {
        query: async (query: unknown) => {
          if (query === convexApi.federatedListSnapshot) {
            listQueries += 1;
            if (listQueries === 1) {
              throw new Error("[Request ID: bfdf4caebe0312d8] Server Error");
            }
            return listSnapshot;
          }
          return fullSnapshot;
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    expect(await store.readFederatedSnapshot("quest")).toEqual(listSnapshot);
    expect(await store.readFederatedSnapshot("quest")).toEqual(listSnapshot);
    expect(listQueries).toBe(2);
  });

  test("streams federated snapshots and closes the realtime subscription", async () => {
    const fake = fakeClients();
    const store = new ConvexStore("http://127.0.0.1:3210", { clients: fake.clients });
    const emissions: unknown[] = [];
    let subscription: Awaited<ReturnType<ConvexStore["watchFederatedSnapshot"]>> | undefined;

    try {
      subscription = await store.watchFederatedSnapshot("quest", (snapshot) =>
        emissions.push(snapshot),
      );
      const snapshot = {
        dump: {
          chains: [],
          quests: [],
          schema_version: STORE_SCHEMA_VERSION,
        },
        fencedRepositories: ["migrating"],
      };

      fake.entries[0]?.callback(snapshot);
      expect(emissions).toEqual([snapshot]);
      expect(fake.httpQueries()).toBe(2);
      expect(fake.entries[0]?.args).toEqual({
        client_protocol: QUEST_CLIENT_PROTOCOL,
        repository: "quest",
      });
      await subscription.unsubscribe();
      subscription = undefined;
      expect(fake.entries[0]?.unsubscribed).toBeTrue();
    } finally {
      await subscription?.unsubscribe();
    }
  });

  test("does not let an expired-lease refresh overwrite a newer realtime snapshot", async () => {
    let queryCount = 0;
    let resolveRefresh: ((snapshot: unknown) => void) | undefined;
    const entries: RealtimeEntry[] = [];
    const clients = {
      http: {
        query: async (query: unknown) => {
          if (query === convexApi.serverTime) {
            return timestamp;
          }
          queryCount += 1;
          if (queryCount === 1) {
            return snapshot("Initial HTTP snapshot");
          }
          return new Promise((resolve) => {
            resolveRefresh = resolve;
          });
        },
      },
      realtime: {
        close: async () => undefined,
        onUpdate: (
          _query: unknown,
          args: Readonly<Record<string, unknown>>,
          callback: (value: unknown) => void,
        ) => {
          const entry = { args, callback, unsubscribed: false };
          entries.push(entry);
          return { unsubscribe: () => undefined };
        },
      },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });
    const emissions: Array<{ readonly dump: { readonly quests: readonly { title: string }[] } }> =
      [];
    let subscription: Awaited<ReturnType<ConvexStore["watchFederatedSnapshot"]>> | undefined;
    const { backfill: _backfill, ...storedQuestFields } = quest;
    const expiringQuest = questSchema.parse({
      ...storedQuestFields,
      created_at: timestamp,
      id: 1,
      lease_expires_at: "2026-08-05T20:00:00.001Z",
      status: "accepted",
      updated_at: timestamp,
    });
    const snapshot = (title: string) => ({
      dump: {
        chains: [],
        quests: [{ ...expiringQuest, title }],
        schema_version: STORE_SCHEMA_VERSION,
      },
      fencedRepositories: [],
    });

    try {
      subscription = await store.watchFederatedSnapshot(undefined, (value) =>
        emissions.push(value),
      );
      entries[0]?.callback(snapshot("Older lease snapshot"));
      await Bun.sleep(10);
      entries[0]?.callback(snapshot("New realtime snapshot"));
      resolveRefresh?.(snapshot("Stale HTTP snapshot"));
      await Bun.sleep(10);

      expect(emissions.at(-1)?.dump.quests[0]?.title).toBe("New realtime snapshot");
    } finally {
      await subscription?.unsubscribe();
    }
  });

  test("retries a lease rebind without dropping the existing subscriptions", async () => {
    const fake = fakeClients();
    const store = new ConvexStore("http://127.0.0.1:3210", { clients: fake.clients });
    const errors: Error[] = [];
    let subscription: Awaited<ReturnType<ConvexStore["watch"]>> | undefined;
    const expiringQuest = {
      ...quest,
      lease_expires_at: "2026-08-05T20:00:00.001Z",
      status: "accepted",
    };

    try {
      subscription = await store.watch({}, (_quests, error) => {
        if (error !== undefined) {
          errors.push(error);
        }
      });
      fake.failNextQuery();
      fake.entries[1]?.callback([expiringQuest]);
      await Bun.sleep(1_100);

      expect(errors.map((error) => error.message)).toContain("temporary server-time failure");
      expect(fake.httpQueries()).toBe(3);
      expect(fake.entries).toHaveLength(4);
      expect(fake.entries.slice(0, 2).every((entry) => entry.unsubscribed)).toBeTrue();
    } finally {
      await subscription?.unsubscribe();
    }
  });
});

describe("Convex atomic claim detail", () => {
  test("falls back to the legacy atomic export during a rolling backend upgrade", async () => {
    const { backfill: _backfill, ...storedQuestFields } = quest;
    const acceptedQuest = questSchema.parse({
      ...storedQuestFields,
      assignee: "test",
      created_at: timestamp,
      id: 1,
      lease_expires_at: null,
      status: "accepted",
      updated_at: timestamp,
    });
    const acceptance = {
      lease_expires_at: null,
      outcome: "accepted" as const,
      quest: acceptedQuest,
    };
    const mutations: unknown[] = [];
    const clients = {
      http: {
        mutation: async (mutation: unknown) => {
          mutations.push(mutation);
          if (mutation === convexApi.acceptQuestAndDetail) {
            throw new Error("[Request ID: bfdf4caebe0312d8] Server Error");
          }
          return {
            acceptance,
            snapshot: {
              chains: [],
              events: [],
              evidence: [],
              quests: [acceptedQuest],
              schema_version: STORE_SCHEMA_VERSION,
            },
          };
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.acceptQuestAndDetail({ id: 1, owner: "test" })).resolves.toEqual({
      acceptance,
      detail: {
        chains: [],
        events: [],
        evidence: [],
        quest: acceptedQuest,
        related_quests: [],
      },
    });
    expect(mutations).toEqual([convexApi.acceptQuestAndDetail, convexApi.acceptQuestAndExport]);
  });
});

describe("Convex event query pagination", () => {
  const event = (id: number): Event => ({
    id,
    quest_id: 1,
    at: timestamp,
    actor: "pagination/tester",
    action: "update",
    detail: { id },
  });

  test("assembles every event page behind the store contract", async () => {
    const queryArgs: Readonly<Record<string, unknown>>[] = [];
    const clients = {
      http: {
        query: async (query: unknown, args: Readonly<Record<string, unknown>>) => {
          if (query === convexApi.serverTime) {
            return timestamp;
          }
          queryArgs.push(args);
          return args["cursor"] === null
            ? { items: [event(1)], next_cursor: "page-2" }
            : { items: [event(2)], next_cursor: null };
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.queryEvents({ after_id: 0 })).resolves.toEqual([event(1), event(2)]);
    expect(queryArgs.map((args) => args["cursor"])).toEqual([null, "page-2"]);
    expect(queryArgs.map((args) => args["filter"])).toEqual([{ after_id: 0 }, { after_id: 0 }]);
  });

  test("restarts from page one when a write invalidates the event snapshot", async () => {
    const cursors: unknown[] = [];
    let pageTwoAttempts = 0;
    const clients = {
      http: {
        query: async (query: unknown, args: Readonly<Record<string, unknown>>) => {
          if (query === convexApi.serverTime) {
            return timestamp;
          }
          const cursor = args["cursor"];
          cursors.push(cursor);
          if (cursor === null) {
            return { items: [event(1)], next_cursor: "page-2" };
          }
          pageTwoAttempts += 1;
          if (pageTwoAttempts === 1) {
            throw new Error(
              "[CONVEX_SNAPSHOT_CHANGED] the Convex store changed while its paginated events were being read",
            );
          }
          return { items: [event(2)], next_cursor: null };
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.queryEvents({ after_id: 0 })).resolves.toEqual([event(1), event(2)]);
    expect(cursors).toEqual([null, "page-2", null, "page-2"]);
  });

  test("retries without a cursor when an older backend rejects paging", async () => {
    const queryArgs: Readonly<Record<string, unknown>>[] = [];
    const clients = {
      http: {
        query: async (query: unknown, args: Readonly<Record<string, unknown>>) => {
          if (query === convexApi.serverTime) {
            return timestamp;
          }
          queryArgs.push(args);
          if ("cursor" in args) {
            throw new Error(
              "ArgumentValidationError: Object contains extra field cursor that is not in the validator",
            );
          }
          return [event(1)];
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.queryEvents({ after_id: 0 })).resolves.toEqual([event(1)]);
    expect(queryArgs.map((args) => args["cursor"])).toEqual([null, undefined]);
  });
});

describe("Convex restore rolling upgrades", () => {
  test("resumes replaceAll when a commit response is lost after deletion starts", async () => {
    const empty: QuestDump = {
      schema_version: STORE_SCHEMA_VERSION,
      quests: [],
      evidence: [],
      chains: [],
      events: [],
    };
    const mutations: unknown[] = [];
    let commitAttempts = 0;
    const clients = {
      http: {
        query: async (query: unknown) => {
          if (query === convexApi.serverTime) {
            return timestamp;
          }
          if (query === convexApi.activeRestore) {
            return null;
          }
          return empty;
        },
        mutation: async (mutation: unknown) => {
          mutations.push(mutation);
          if (mutation === convexApi.beginRestore) {
            return { status: "ready" };
          }
          if (mutation === convexApi.commitRestore) {
            commitAttempts += 1;
            if (commitAttempts === 1) {
              throw new Error("connection closed after commit");
            }
            return { lease_cutoff: timestamp, status: "committed" };
          }
          if (mutation === convexApi.releaseRestore) {
            return true;
          }
          return null;
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.replaceAll(empty)).resolves.toBeUndefined();

    expect(commitAttempts).toBe(2);
    expect(mutations).not.toContain(convexApi.rollbackRestore);
    expect(mutations.at(-1)).toBe(convexApi.releaseRestore);
  });

  test("lets a fresh client discover and finish a partial restore", async () => {
    const empty: QuestDump = {
      schema_version: STORE_SCHEMA_VERSION,
      quests: [],
      evidence: [],
      chains: [],
      events: [],
    };
    const mutations: unknown[] = [];
    const clients = {
      http: {
        query: async (query: unknown) => {
          if (query === convexApi.activeRestore) {
            return mutations.includes(convexApi.releaseRestore)
              ? null
              : { status: "deleting", token: "interrupted-token" };
          }
          return query === convexApi.serverTime ? timestamp : empty;
        },
        mutation: async (mutation: unknown) => {
          mutations.push(mutation);
          if (mutation === convexApi.commitRestore) {
            return { lease_cutoff: timestamp, status: "committed" };
          }
          if (mutation === convexApi.releaseRestore) {
            return true;
          }
          return null;
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.exportAll()).resolves.toEqual(empty);
    expect(mutations).toEqual([convexApi.commitRestore, convexApi.releaseRestore]);
  });

  test("lets a fresh client discard an expired restore interrupted before commit", async () => {
    const empty: QuestDump = {
      schema_version: STORE_SCHEMA_VERSION,
      quests: [],
      evidence: [],
      chains: [],
      events: [],
    };
    const mutations: unknown[] = [];
    const clients = {
      http: {
        query: async (query: unknown) =>
          query === convexApi.activeRestore
            ? { status: "expired", token: "interrupted-token" }
            : empty,
        mutation: async (mutation: unknown) => {
          mutations.push(mutation);
          return mutation === convexApi.releaseRestore;
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.resumeInterruptedRestore()).resolves.toBeTrue();
    expect(mutations).toEqual([convexApi.releaseRestore]);
  });

  test("does not let a fresh client discard an unexpired restore", async () => {
    const mutations: unknown[] = [];
    const clients = {
      http: {
        query: async () => null,
        mutation: async (mutation: unknown) => {
          mutations.push(mutation);
          return true;
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.resumeInterruptedRestore()).resolves.toBeFalse();
    expect(mutations).toEqual([]);
  });

  test("uses the legacy monolithic restore only when the previous validator rejects paging", async () => {
    const empty: QuestDump = {
      schema_version: STORE_SCHEMA_VERSION,
      quests: [],
      evidence: [],
      chains: [],
      events: [],
    };
    const calls: Array<{ readonly args: Record<string, unknown>; readonly mutation: unknown }> = [];
    const clients = {
      http: {
        mutation: async (mutation: unknown, args: Record<string, unknown>) => {
          calls.push({ args, mutation });
          if (mutation === convexApi.beginRestore && "expected_hash" in args) {
            throw new Error(
              "ArgumentValidationError: Object contains extra field expected_hash that is not in the validator",
            );
          }
          if (mutation === convexApi.activateRestore) {
            return args["dump"];
          }
          return null;
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    const token = await store.beginRestore(empty, timestamp, "migration", 0);
    await expect(store.activateRestore(token, empty)).resolves.toEqual(empty);

    expect(calls.map((call) => call.mutation)).toEqual([
      convexApi.beginRestore,
      convexApi.beginRestore,
      convexApi.activateRestore,
    ]);
    expect(calls[1]?.args["expected_snapshot"]).toBe(JSON.stringify(empty));
    expect(calls.some((call) => call.mutation === convexApi.uploadRestorePage)).toBeFalse();
  });

  test("rolls back a legacy restore when the backend upgrades before commit", async () => {
    const empty: QuestDump = {
      schema_version: STORE_SCHEMA_VERSION,
      quests: [],
      evidence: [],
      chains: [],
      events: [],
    };
    const mutations: unknown[] = [];
    const clients = {
      http: {
        query: async (query: unknown) => {
          if (query === convexApi.activeRestore) {
            return null;
          }
          if (query === convexApi.serverTime) {
            return timestamp;
          }
          return empty;
        },
        mutation: async (mutation: unknown, args: Record<string, unknown>) => {
          mutations.push(mutation);
          if (mutation === convexApi.beginRestore && "expected_hash" in args) {
            throw new Error(
              "ArgumentValidationError: Object contains extra field expected_hash that is not in the validator",
            );
          }
          if (mutation === convexApi.activateRestore) {
            return args["dump"];
          }
          if (mutation === convexApi.commitRestore) {
            throw new Error(
              "[CONVEX_MONOLITHIC_DUMP_UNSUPPORTED] this restore needs the current paging protocol",
            );
          }
          return null;
        },
      },
      realtime: { close: async () => undefined },
    } as unknown as ConvexClientPair;
    const store = new ConvexStore("http://127.0.0.1:3210", { clients });

    await expect(store.replaceAll(empty)).rejects.toThrow("safely rolled it back");
    expect(mutations.filter((mutation) => mutation === convexApi.commitRestore)).toHaveLength(1);
    expect(mutations.at(-1)).toBe(convexApi.rollbackRestore);
  });
});
