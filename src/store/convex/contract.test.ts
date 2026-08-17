import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { type NewQuest, type QuestDump, STORE_SCHEMA_VERSION } from "../../schema";
import {
  type BlobStoreFactory,
  defineBlobStoreContract,
  defineQuestStoreContract,
  defineReviewerHandoffContract,
  type QuestStoreFactory,
} from "../contract";
import type { BackupDatabaseRestoreSession, StoreMigrationSession } from "../port";
import { ConvexStore } from "./adapter";
import { ConvexBackupDatabase } from "./backup";
import { ConvexBlobStore } from "./blob-store";
import { closeConvexClientPair, convexApi, createConvexClientPair } from "./client";
import { parseConvexEventPage } from "./pagination";
import { MINIMUM_QUEST_CLIENT_PROTOCOL } from "./protocol";

const deployment = process.env["QUEST_CONVEX_TEST_URL"];
const authToken = process.env["QUEST_CONVEX_TEST_TOKEN"];
const reviewerAuthToken = process.env["QUEST_CONVEX_TEST_REVIEWER_TOKEN"];

const emptyDump: QuestDump = {
  schema_version: STORE_SCHEMA_VERSION,
  quests: [],
  evidence: [],
  chains: [],
  events: [],
};

async function flushConvexSubscription(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 150);
  });
}

if (deployment === undefined || authToken === undefined) {
  test.skip("Convex contract suite requires QUEST_CONVEX_TEST_URL and QUEST_CONVEX_TEST_TOKEN", () => {});
} else {
  test.serial("Convex rejects outdated clients before member authentication", async () => {
    const outdatedClient = new ConvexHttpClient(deployment, {
      logger: false,
      skipConvexDeploymentUrlCheck: true,
    });
    const errors: string[] = [];
    for (const args of [{}, { client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL - 1 }]) {
      try {
        await outdatedClient.query(convexApi.federatedSnapshot, args);
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toContain("QUEST_CLI_OUTDATED");
      expect(error).toContain("quest upgrade");
      expect(error).not.toContain("QUEST_CONVEX_TOKEN_REQUIRED");
    }

    let joinError = "";
    try {
      await outdatedClient.mutation(convexApi.join, { invite_token: "not-consumed" });
    } catch (error: unknown) {
      joinError = error instanceof Error ? error.message : String(error);
    }
    expect(joinError).toContain("QUEST_CLI_OUTDATED");
    expect(joinError).not.toContain("QUEST_INVITE_INVALID");

    const clients = createConvexClientPair(deployment, { authToken });
    try {
      await expect(
        clients.http.query(convexApi.federatedSnapshot, { auth_token: authToken }),
      ).resolves.toBeDefined();
    } finally {
      await closeConvexClientPair(clients);
    }
  });

  const questStoreFactory: QuestStoreFactory = async () => {
    const clients = createConvexClientPair(deployment, { authToken });
    const store = new ConvexStore(deployment, { clients });
    const member = await clients.http.mutation(convexApi.whoami, { auth_token: authToken });
    await store.replaceAll(emptyDump);
    return {
      store,
      resolveActor: () => member.member,
      failNextEventAppend: () => store.failNextEventAppend(),
      flushWatch: flushConvexSubscription,
      close: () => closeConvexClientPair(clients),
    };
  };

  const blobStoreFactory: BlobStoreFactory = async () => {
    const clients = createConvexClientPair(deployment, { authToken });
    const store = new ConvexBlobStore(deployment, { clients });
    return {
      store,
      failNextPublish: () => store.failNextPublish(),
      close: () => closeConvexClientPair(clients),
    };
  };

  defineQuestStoreContract("ConvexStore contract against local deployment", questStoreFactory);
  if (reviewerAuthToken === undefined) {
    test.skip("ConvexStore reviewer handoff contract requires QUEST_CONVEX_TEST_REVIEWER_TOKEN", () => {});
  } else {
    const reviewerQuestStoreFactory: QuestStoreFactory = async () => {
      const clients = createConvexClientPair(deployment, { authToken });
      const reviewerClients = createConvexClientPair(deployment, { authToken: reviewerAuthToken });
      const store = new ConvexStore(deployment, { clients });
      const reviewerStore = new ConvexStore(deployment, { clients: reviewerClients });
      const [member, reviewer] = await Promise.all([
        clients.http.mutation(convexApi.whoami, { auth_token: authToken }),
        reviewerClients.http.mutation(convexApi.whoami, { auth_token: reviewerAuthToken }),
      ]);
      await store.replaceAll(emptyDump);
      return {
        store,
        resolveActor: (requestedActor) =>
          requestedActor === "contract/reviewer" ? reviewer.member : member.member,
        storeForActor: (actor) => (actor === reviewer.member ? reviewerStore : store),
        failNextEventAppend: () => store.failNextEventAppend(),
        flushWatch: flushConvexSubscription,
        close: async () => {
          await closeConvexClientPair(clients);
          await closeConvexClientPair(reviewerClients);
        },
      };
    };
    defineReviewerHandoffContract(
      "ConvexStore reviewer handoff contract against local deployment",
      reviewerQuestStoreFactory,
    );
  }
  defineBlobStoreContract("ConvexBlobStore contract against local deployment", blobStoreFactory);

  test.serial(
    "Convex restore leases block concurrent writes and roll back atomically",
    async () => {
      const primaryClients = createConvexClientPair(deployment, { authToken });
      const concurrentClients = createConvexClientPair(deployment, { authToken });
      const primary = new ConvexStore(deployment, { clients: primaryClients });
      const concurrent = new ConvexStore(deployment, { clients: concurrentClients });
      const quest: NewQuest = {
        repo: "convex-contract",
        area: null,
        kind: "task",
        title: "restore lease",
        description: "restore lease",
        opened_by: "contract/tester",
        guild: null,
        assignee: null,
        status: "open",
        verdict: null,
        verdict_notes: null,
        priority: 2,
        pr: null,
        predicted_files: [],
        reopen_count: 0,
        lease_expires_at: null,
        backfill: false,
      };
      let token: string | undefined;
      try {
        await primary.replaceAll(emptyDump);
        await primary.addQuest(quest);
        const previous = await primary.exportAllWithCutoff();
        token = await primary.beginRestore(
          previous.dump,
          previous.lease_cutoff,
          "full-backup",
          previous.event_high_water,
        );
        await primary.activateRestore(token, emptyDump);
        await expect(concurrent.addQuest({ ...quest, title: "blocked" })).rejects.toThrow(
          "restore is in progress",
        );
        await primary.rollbackRestore(token);
        token = undefined;
        expect((await primary.exportAll()).quests).toHaveLength(1);
        await concurrent.addQuest({ ...quest, title: "after rollback" });
      } finally {
        if (token !== undefined) {
          await primary.releaseRestore(token).catch(() => undefined);
        }
        await primary.replaceAll(emptyDump).catch(() => undefined);
        await closeConvexClientPair(primaryClients);
        await closeConvexClientPair(concurrentClients);
      }
    },
  );

  test.serial("a fresh Convex client resumes an interrupted paginated restore", async () => {
    const primaryClients = createConvexClientPair(deployment, { authToken });
    const freshClients = createConvexClientPair(deployment, { authToken });
    const primary = new ConvexStore(deployment, { clients: primaryClients });
    const fresh = new ConvexStore(deployment, { clients: freshClients });
    let token: string | undefined;
    try {
      await primary.replaceAll(emptyDump);
      const previous = await primary.exportAllWithCutoff();
      token = await primary.beginRestore(
        previous.dump,
        previous.lease_cutoff,
        "full-backup",
        previous.event_high_water,
      );
      await primary.activateRestore(token, emptyDump);
      await expect(
        primaryClients.http.mutation(convexApi.commitRestore, {
          auth_token: authToken,
          client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
          token,
        }),
      ).resolves.toEqual({ status: "pending" });

      expect(await fresh.exportAll()).toEqual(emptyDump);
      token = undefined;
      await expect(
        freshClients.http.query(convexApi.activeRestore, {
          auth_token: authToken,
          client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
        }),
      ).resolves.toBeNull();
    } finally {
      if (token !== undefined) {
        await primary.commitRestore(token).catch(() => undefined);
        await primary.releaseRestore(token).catch(() => undefined);
      }
      await fresh.replaceAll(emptyDump).catch(() => undefined);
      await closeConvexClientPair(primaryClients);
      await closeConvexClientPair(freshClients);
    }
  });

  test.serial("a fresh Convex client cannot cancel a live restore before commit", async () => {
    const primaryClients = createConvexClientPair(deployment, { authToken });
    const freshClients = createConvexClientPair(deployment, { authToken });
    const primary = new ConvexStore(deployment, { clients: primaryClients });
    const fresh = new ConvexStore(deployment, { clients: freshClients });
    let token: string | undefined;
    try {
      await primary.replaceAll(emptyDump);
      const previous = await primary.exportAllWithCutoff();
      token = await primary.beginRestore(
        previous.dump,
        previous.lease_cutoff,
        "full-backup",
        previous.event_high_water,
      );
      await primary.activateRestore(token, emptyDump);

      expect(await fresh.resumeInterruptedRestore()).toBeFalse();
      expect(await fresh.exportAll()).toEqual(previous.dump);
      await primary.rollbackRestore(token);
      token = undefined;
    } finally {
      if (token !== undefined) {
        await primary.releaseRestore(token).catch(() => undefined);
      }
      await fresh.replaceAll(emptyDump).catch(() => undefined);
      await closeConvexClientPair(primaryClients);
      await closeConvexClientPair(freshClients);
    }
  });

  test.serial("ConvexBlobStore snapshots caller bytes before upload", async () => {
    const clients = createConvexClientPair(deployment, { authToken });
    const store = new ConvexBlobStore(deployment, { clients });
    const bytes = new Uint8Array([11, 22, 33, 44]);
    const expected = new Uint8Array(bytes);
    const pending = store.put(bytes);
    bytes.fill(0);
    const hash = await pending;
    try {
      expect(await store.get(hash)).toEqual(expected);
      expect((await store.restore(hash, expected)).copied).toBeFalse();
    } finally {
      await closeConvexClientPair(clients);
    }
  });

  test.serial("committed migration fences retain a fingerprint for recovery", async () => {
    const clients = createConvexClientPair(deployment, { authToken });
    const store = new ConvexStore(deployment, { clients });
    let session: StoreMigrationSession | undefined;
    try {
      await store.replaceAll(emptyDump);
      const quest: NewQuest = {
        repo: "convex-contract",
        area: null,
        kind: "task",
        title: "committed fence",
        description: "committed fence",
        opened_by: "contract/tester",
        guild: null,
        assignee: null,
        status: "open",
        verdict: null,
        verdict_notes: null,
        priority: 2,
        pr: null,
        predicted_files: [],
        reopen_count: 0,
        lease_expires_at: null,
        backfill: false,
      };
      await store.addQuest(quest);
      session = await store.beginMigration(await store.exportAll());
      await session.fence("convex-contract");
      await session.commit();
      await expect(store.recoverMigrationFence("convex-contract")).rejects.toThrow(
        "MIGRATION_FENCE_RECOVERY_BLOCKED",
      );
      await session.release();
      session = undefined;
      await store.addQuest({ ...quest, repo: "other-repository", title: "unrelated write" });
      expect(await store.recoverMigrationFence("convex-contract")).toBeTrue();
      await store.addQuest({ ...quest, title: "recovery unblocked" });
    } finally {
      if (session !== undefined) {
        await session.unfence("convex-contract").catch(() => undefined);
        await session.release().catch(() => undefined);
      }
      for (const repository of ["convex-contract", "other-repository"]) {
        await store.recoverMigrationFence(repository).catch(() => false);
      }
      await store.replaceAll(emptyDump).catch(() => undefined);
      await closeConvexClientPair(clients);
    }
  });

  test.serial("uncommitted migration rollback removes its repository fence", async () => {
    const clients = createConvexClientPair(deployment, { authToken });
    const store = new ConvexStore(deployment, { clients });
    let session: StoreMigrationSession | undefined;
    try {
      await store.replaceAll(emptyDump);
      const quest: NewQuest = {
        repo: "convex-contract",
        area: null,
        kind: "task",
        title: "uncommitted fence",
        description: "uncommitted fence",
        opened_by: "contract/tester",
        guild: null,
        assignee: null,
        status: "open",
        verdict: null,
        verdict_notes: null,
        priority: 2,
        pr: null,
        predicted_files: [],
        reopen_count: 0,
        lease_expires_at: null,
        backfill: false,
      };
      await store.addQuest(quest);
      session = await store.beginMigration(await store.exportAll());
      await session.fence("convex-contract");
      await session.rollback();
      await session.release();
      session = undefined;

      expect(await store.recoverMigrationFence("convex-contract")).toBeFalse();
      await store.addQuest({ ...quest, title: "rollback unblocked" });
    } finally {
      if (session !== undefined) {
        await session.unfence("convex-contract").catch(() => undefined);
        await session.release().catch(() => undefined);
      }
      await store.recoverMigrationFence("convex-contract").catch(() => false);
      await store.replaceAll(emptyDump).catch(() => undefined);
      await closeConvexClientPair(clients);
    }
  });

  test.serial(
    "Convex backup restore preserves cross-repository chains and committed fences",
    async () => {
      const clients = createConvexClientPair(deployment, { authToken });
      const store = new ConvexStore(deployment, { clients });
      const directory = await mkdtemp(join(tmpdir(), "quest-convex-restore-fence-"));
      let session: StoreMigrationSession | undefined;
      let restore: BackupDatabaseRestoreSession | undefined;
      try {
        await store.replaceAll(emptyDump);
        const quest: NewQuest = {
          repo: "convex-contract",
          area: null,
          kind: "task",
          title: "restore fence",
          description: "restore fence",
          opened_by: "contract/tester",
          guild: null,
          assignee: null,
          status: "open",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          predicted_files: [],
          reopen_count: 0,
          lease_expires_at: null,
          backfill: false,
        };
        const targetQuest = await store.addQuest(quest);
        const otherQuest = await store.addQuest({
          ...quest,
          repo: "other-repository",
          title: "other fence",
        });
        await store.addChainLink({
          link: { quest_id: targetQuest.id, target_id: otherQuest.id, type: "duplicate-of" },
          actor: "contract/tester",
          session_guild: null,
        });
        await store.addChainLink({
          link: { quest_id: otherQuest.id, target_id: targetQuest.id, type: "duplicate-of" },
          actor: "contract/tester",
          session_guild: null,
        });
        const previous = await store.exportAllWithCutoff();
        const snapshotPath = join(directory, "snapshot.json");
        await writeFile(snapshotPath, `${JSON.stringify(previous.dump)}\n`);
        session = await store.beginMigration(previous.dump);
        await session.fence("convex-contract");
        await session.fence("other-repository");
        await session.commit();
        await session.release();
        session = undefined;
        await store.addQuest({
          ...quest,
          repo: "unrelated-repository",
          title: "unrelated write after backup",
        });

        const backup = new ConvexBackupDatabase(join(directory, "quest.convex.json"), store);
        const fullBackup = new ConvexBackupDatabase(join(directory, "quest.full.json"), store);
        await expect(fullBackup.restoreSnapshot(snapshotPath, "full-restore")).rejects.toThrow(
          "BACKUP_FULL_RESTORE_FENCED",
        );
        restore = await backup.restoreSnapshot(snapshotPath, "committed-fence", "convex-contract");
        await restore.rollback();
        await expect(
          store.addQuest({ ...quest, title: "rollback keeps the fence" }),
        ).rejects.toThrow("MIGRATION_REPOSITORY_FENCED");

        restore = await backup.restoreSnapshot(snapshotPath, "committed-fence", "convex-contract");
        await restore.activate();
        await restore.commit();

        expect(await store.recoverMigrationFence("convex-contract")).toBeFalse();
        await store.addQuest({ ...quest, title: "writes resume after backup restore" });
        await expect(
          store.addQuest({ ...quest, repo: "other-repository", title: "other remains fenced" }),
        ).rejects.toThrow("MIGRATION_REPOSITORY_FENCED");
        expect(await store.listQuests({ repo: "unrelated-repository" })).toHaveLength(1);
        expect(await store.exportAll()).toMatchObject({
          chains: [
            { quest_id: targetQuest.id, target_id: otherQuest.id, type: "duplicate-of" },
            { quest_id: otherQuest.id, target_id: targetQuest.id, type: "duplicate-of" },
          ],
        });
      } finally {
        await restore?.rollback().catch(() => undefined);
        if (session !== undefined) {
          await session.unfence("convex-contract").catch(() => undefined);
          await session.unfence("other-repository").catch(() => undefined);
          await session.release().catch(() => undefined);
        }
        for (const repository of ["convex-contract", "other-repository"]) {
          await store.recoverMigrationFence(repository).catch(() => false);
        }
        await store.replaceAll(emptyDump).catch(() => undefined);
        await rm(directory, { force: true, recursive: true });
        await closeConvexClientPair(clients);
      }
    },
  );

  test.serial(
    "Convex paginated reads round-trip more than 8192 events by count and value size",
    async () => {
      const clients = createConvexClientPair(deployment, { authToken });
      const store = new ConvexStore(deployment, { clients });
      const directory = await mkdtemp(join(tmpdir(), "quest-convex-pagination-"));
      const timestamp = "2026-08-17T00:00:00.000Z";
      const quests: QuestDump["quests"] = Array.from({ length: 3 }, (_, index) => ({
        id: index + 1,
        repo: "convex-pagination",
        area: "store",
        kind: "bug",
        title: `Large history ${index + 1}`,
        description: "Convex pagination contract fixture",
        opened_by: "contract/tester",
        guild: null,
        assignee: null,
        status: "open",
        verdict: null,
        verdict_notes: null,
        priority: 2,
        pr: null,
        predicted_files: [],
        reopen_count: 0,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      }));
      const events: QuestDump["events"] = Array.from({ length: 8_193 }, (_, index) => ({
        id: index + 1,
        quest_id: (index % quests.length) + 1,
        at: timestamp,
        actor: "contract/tester",
        action: "update",
        detail: {
          sequence: index + 1,
          ...(index < 64 ? { payload: "v".repeat(300_000) } : {}),
        },
      }));
      const expected: QuestDump = {
        schema_version: STORE_SCHEMA_VERSION,
        quests,
        evidence: [],
        chains: [],
        events,
      };
      let rollbackToken: string | undefined;
      try {
        await store.replaceAll(emptyDump);
        const initial = await store.exportAllWithCutoff();
        const legacyToken = await store.beginRestore(
          initial.dump,
          initial.lease_cutoff,
          "full-backup",
          initial.event_high_water,
        );
        await expect(
          clients.http.mutation(convexApi.activateRestore, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            token: legacyToken,
            dump: emptyDump,
          }),
        ).rejects.toThrow("CONVEX_MONOLITHIC_DUMP_UNSUPPORTED");
        await store.rollbackRestore(legacyToken);

        const stabilityCutoff = await store.serverTime();
        const firstStabilityPage = await clients.http.query(convexApi.exportAll, {
          auth_token: authToken,
          client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
          lease_cutoff: stabilityCutoff,
        });
        if (!("section" in firstStabilityPage) || firstStabilityPage.next_cursor === null) {
          throw new Error("expected the empty snapshot to continue to its next section");
        }
        await store.addQuest({
          repo: "convex-pagination",
          area: "store",
          kind: "bug",
          title: "Concurrent snapshot write",
          description: "Changes the event high-water mark between pages",
          opened_by: "contract/tester",
          guild: null,
          assignee: null,
          status: "open",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          predicted_files: [],
          reopen_count: 0,
          lease_expires_at: null,
          backfill: false,
        });
        await expect(
          clients.http.query(convexApi.exportAll, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            cursor: firstStabilityPage.next_cursor,
            lease_cutoff: stabilityCutoff,
          }),
        ).rejects.toThrow("CONVEX_SNAPSHOT_CHANGED");

        await store.replaceAll(expected);
        const queriedEvents = await store.queryEvents({ after_id: 0 });
        expect(queriedEvents).toHaveLength(8_193);
        expect(queriedEvents[0]?.id).toBe(1);
        expect(queriedEvents.at(-1)?.id).toBe(8_193);
        await expect(
          clients.http.query(convexApi.queryEvents, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            filter: { after_id: 8_190 },
            lease_cutoff: await store.serverTime(),
          }),
        ).resolves.toEqual(events.slice(8_190));
        await expect(
          clients.http.mutation(convexApi.acceptQuestAndExport, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            input: { id: 1, owner: "contract/tester", session_guild: null },
          }),
        ).rejects.toThrow("CONVEX_MONOLITHIC_DUMP_UNSUPPORTED");
        expect((await store.getQuest(1))?.status).toBe("open");
        expect((await store.exportAll()).events).toHaveLength(8_193);
        expect((await store.readFederatedFullSnapshot()).dump.events).toHaveLength(8_193);
        expect((await store.readQuestDetail(1)).events).toHaveLength(2_731);

        const pageCutoff = await store.serverTime();
        let page = await clients.http.query(convexApi.exportAll, {
          auth_token: authToken,
          client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
          lease_cutoff: pageCutoff,
        });
        while ("section" in page && page.section !== "events" && page.next_cursor !== null) {
          page = await clients.http.query(convexApi.exportAll, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            cursor: page.next_cursor,
            lease_cutoff: pageCutoff,
          });
        }
        if (!("section" in page) || page.section !== "events") {
          throw new Error("expected the paginated export to reach its events section");
        }
        expect(page.items.length).toBeLessThan(12);
        expect(page.next_cursor).not.toBeNull();
        const preRestoreCursor = page.next_cursor;
        if (preRestoreCursor === null) {
          throw new Error("expected an in-flight cursor before replacing the store");
        }

        const backupPath = join(directory, "large.json");
        const backup = new ConvexBackupDatabase(join(directory, "live.json"), store);
        expect((await backup.createSnapshot(backupPath)).dump.events).toHaveLength(8_193);
        await store.replaceAll(emptyDump);
        await expect(
          clients.http.query(convexApi.exportAll, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            cursor: preRestoreCursor,
            lease_cutoff: pageCutoff,
          }),
        ).rejects.toThrow("CONVEX_SNAPSHOT_CHANGED");
        const restore = await backup.restoreSnapshot(backupPath, "large-round-trip");
        await restore.activate();
        await restore.commit();
        expect((await store.exportAll()).events).toHaveLength(8_193);

        const rollbackSource = await store.exportAllWithCutoff();
        rollbackToken = await store.beginRestore(
          rollbackSource.dump,
          rollbackSource.lease_cutoff,
          "full-backup",
          rollbackSource.event_high_water,
        );
        await store.activateRestore(rollbackToken, expected);
        await store.rollbackRestore(rollbackToken);
        rollbackToken = undefined;
        expect((await store.exportAll()).events).toHaveLength(8_193);

        const eventCutoff = await store.serverTime();
        const firstEventPage = parseConvexEventPage(
          await clients.http.query(convexApi.queryEvents, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            cursor: null,
            filter: { after_id: 0 },
            lease_cutoff: eventCutoff,
          }),
        );
        expect(firstEventPage.next_cursor).not.toBeNull();
        await store.transition(1, {
          action: "update",
          actor: "contract/tester",
          changes: { area: "changed-after-first-event-page" },
        });
        await expect(
          clients.http.query(convexApi.queryEvents, {
            auth_token: authToken,
            client_protocol: MINIMUM_QUEST_CLIENT_PROTOCOL,
            cursor: firstEventPage.next_cursor,
            filter: { after_id: 0 },
            lease_cutoff: eventCutoff,
          }),
        ).rejects.toThrow("CONVEX_SNAPSHOT_CHANGED");
      } finally {
        if (rollbackToken !== undefined) {
          await store.rollbackRestore(rollbackToken).catch(() => undefined);
          await store.releaseRestore(rollbackToken).catch(() => undefined);
        }
        await store.replaceAll(emptyDump).catch(() => undefined);
        await rm(directory, { force: true, recursive: true });
        await closeConvexClientPair(clients);
      }
    },
    120_000,
  );
}
