import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newQuestSchema, type QuestDump, STORE_SCHEMA_VERSION } from "../../schema";
import { LocalBlobStore } from "../local-blob-store";
import type { FederatedFullSnapshot } from "../port";
import { FederatedQuestStore, type FederatedStoreSource } from "../routing";
import { ConvexStore } from "./adapter";
import { closeConvexClientPair, convexApi, createConvexClientPair } from "./client";

const deployment = process.env["QUEST_CONVEX_LEGACY_TEST_URL"];
const authToken = process.env["QUEST_CONVEX_LEGACY_TEST_TOKEN"];
const receiptPath = process.env["QUEST_CONVEX_LEGACY_TEST_RECEIPT"];
const repositories = ["ekualiti-kc", "fundfit", "streamlyne"] as const;

const emptyDump: QuestDump = {
  schema_version: STORE_SCHEMA_VERSION,
  quests: [],
  evidence: [],
  chains: [],
  events: [],
};

function requireLocalDeployment(address: string): void {
  const hostname = new URL(address).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(
      "[ROLLING_UPGRADE_TEST_REQUIRES_LOCAL_BACKEND] QUEST_CONVEX_LEGACY_TEST_URL must point to a local backend built from main; refusing to replace data on a remote deployment",
    );
  }
}

function requireEmptyDeployment(snapshot: FederatedFullSnapshot): void {
  const counts = {
    chains: snapshot.dump.chains.length,
    events: snapshot.dump.events.length,
    evidence: snapshot.dump.evidence.length,
    fences: snapshot.fencedRepositories.length,
    quests: snapshot.dump.quests.length,
  };
  if (Object.values(counts).some((count) => count !== 0)) {
    throw new Error(
      `[ROLLING_UPGRADE_TEST_BACKEND_NOT_EMPTY] the local legacy backend contains ${JSON.stringify(counts)}; start a fresh main-functions backend with \`make backend\` and retry with its URL and member token. No data was changed.`,
    );
  }
}

if ((deployment === undefined) !== (authToken === undefined)) {
  throw new Error(
    "[ROLLING_UPGRADE_TEST_CONFIG_INCOMPLETE] set both QUEST_CONVEX_LEGACY_TEST_URL and QUEST_CONVEX_LEGACY_TEST_TOKEN, or clear both to omit the local rolling-upgrade drill",
  );
}

if (deployment !== undefined && authToken !== undefined) {
  test.serial(
    "new viewer client retains every routed repository against main functions",
    async () => {
      requireLocalDeployment(deployment);
      const directory = await mkdtemp(join(tmpdir(), "quest-rolling-upgrade-"));
      const clients = createConvexClientPair(deployment, { authToken });
      const store = new ConvexStore(deployment, { clients });
      const source: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(directory, "evidence")),
        includeRepository: (repository) =>
          repositories.includes(repository as (typeof repositories)[number]),
        questStore: store,
        readFullSnapshot: () => store.readFederatedFullSnapshot(),
        readSnapshot: (repository) => store.readFederatedSnapshot(repository),
        routesRepository: (repository) =>
          repositories.includes(repository as (typeof repositories)[number]),
        watchSnapshot: (repository, listener) => store.watchFederatedSnapshot(repository, listener),
      };
      const federated = new FederatedQuestStore([source], undefined, { allowPartialReads: true });
      requireEmptyDeployment(await store.readFederatedFullSnapshot());

      try {
        await store.replaceAll(emptyDump);
        for (const repository of repositories) {
          await store.addQuest(
            newQuestSchema.parse({
              area: "store",
              assignee: null,
              backfill: false,
              description: `Rolling-upgrade fixture for ${repository}`,
              guild: null,
              kind: "task",
              opened_by: "rolling-upgrade",
              predicted_files: [],
              priority: 2,
              pr: null,
              repo: repository,
              reopen_count: 0,
              status: "open",
              title: `${repository} remains visible`,
              verdict: null,
              verdict_notes: null,
            }),
          );
        }

        const legacySnapshot = await clients.http.query(convexApi.federatedListSnapshot, {
          auth_token: authToken,
        });
        const rCycle: Array<{ readonly repository: string; readonly titles: readonly string[] }> =
          [];
        for (const repository of repositories) {
          const quests = await federated.forRepository(repository).listQuests({});
          rCycle.push({ repository, titles: quests.map((quest) => quest.title) });
        }
        const allRepositories = (await federated.listQuests({})).map((quest) => quest.repo).sort();

        expect(rCycle).toEqual(
          repositories.map((repository) => ({
            repository,
            titles: [`${repository} remains visible`],
          })),
        );
        expect(allRepositories).toEqual([...repositories].sort());

        if (receiptPath !== undefined) {
          await Bun.write(
            receiptPath,
            `${JSON.stringify(
              {
                allRepositories,
                fallback: "client_protocol omitted for strict main validators",
                legacyPayloadBytes: Buffer.byteLength(JSON.stringify(legacySnapshot)),
                rCycle,
              },
              null,
              2,
            )}\n`,
          );
        }
      } finally {
        await store.replaceAll(emptyDump).catch(() => undefined);
        await closeConvexClientPair(clients);
        await rm(directory, { force: true, recursive: true });
      }
    },
  );
}
