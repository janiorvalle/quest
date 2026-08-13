import { z } from "zod";

import { leaseExpiry } from "../domain";
import type { QuestDump } from "../schema";
import {
  chainSchema,
  eventBaseSchema,
  eventSchema,
  evidenceSchema,
  questDumpSchema,
  questSchema,
  STORE_SCHEMA_VERSION,
} from "../schema";
import type { QuestStore } from "../store";

const legacyQuestStatusSchema = z.enum([
  "open",
  "ready",
  "accepted",
  "turned_in",
  "complete",
  "dropped",
]);
const legacyQuestSchema = questSchema.extend({ status: legacyQuestStatusSchema });

const preCancelEventSchema = eventBaseSchema.extend({
  action: z.enum([
    "add",
    "accept",
    "abandon",
    "verdict",
    "turnin",
    "complete",
    "reopen",
    "update",
    "chain",
  ]),
});

const preLeaseEventSchema = eventBaseSchema.extend({
  action: z.enum([
    "add",
    "accept",
    "abandon",
    "verdict",
    "turnin",
    "complete",
    "reopen",
    "cancel",
    "update",
    "chain",
  ]),
});

const preLeaseQuestSchema = legacyQuestSchema.omit({ lease_expires_at: true });

const preSessionAttributionQuestDumpSchema = z.strictObject({
  schema_version: z.literal(4),
  quests: z.array(legacyQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventBaseSchema),
});

const preOpenBugDispatchQuestDumpSchema = z.strictObject({
  schema_version: z.literal(5),
  quests: z.array(legacyQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventSchema),
});

const preLeaseTtlQuestDumpSchema = z.strictObject({
  schema_version: z.literal(6),
  quests: z.array(legacyQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventSchema),
});

const preSignoffQuestDumpSchema = z.strictObject({
  schema_version: z.literal(7),
  quests: z.array(legacyQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventSchema),
});

const preActualFilesQuestDumpSchema = z.strictObject({
  schema_version: z.literal(8),
  quests: z.array(legacyQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventSchema),
});

const preUnifiedOpenQuestDumpSchema = z.strictObject({
  schema_version: z.literal(9),
  quests: z.array(legacyQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventSchema),
});

const preLeaseQuestDumpSchema = z.strictObject({
  schema_version: z.literal(3),
  quests: z.array(preLeaseQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(preLeaseEventSchema),
});

const preCancelQuestDumpSchema = z.strictObject({
  schema_version: z.literal(2),
  quests: z.array(preLeaseQuestSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(preCancelEventSchema),
});

const legacyQuestDumpSchema = z.strictObject({
  schema_version: z.literal(1),
  quests: z.array(
    legacyQuestSchema.omit({ guild: true, lease_expires_at: true }).extend({
      branch: questSchema.shape.pr,
    }),
  ),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(preCancelEventSchema),
});

function leaseForImportedQuest(
  status: z.infer<typeof legacyQuestStatusSchema>,
  assignee: string | null,
  updatedAt: string,
): string | null {
  return status === "accepted" && assignee !== null ? leaseExpiry(updatedAt) : null;
}

function addLeases(quests: readonly z.infer<typeof preLeaseQuestSchema>[]) {
  return quests.map((quest) => ({
    ...quest,
    lease_expires_at: leaseForImportedQuest(quest.status, quest.assignee, quest.updated_at),
  }));
}

function normalizeImportedQuests(
  quests: readonly z.infer<typeof legacyQuestSchema>[],
): QuestDump["quests"] {
  return quests.map((quest) =>
    questSchema.parse({ ...quest, status: quest.status === "ready" ? "open" : quest.status }),
  );
}

export async function createLogicalQuestExport(store: QuestStore): Promise<QuestDump> {
  return questDumpSchema.parse(await store.exportAll());
}

export function serializeQuestBackupExport(dump: QuestDump): string {
  return `${JSON.stringify(questDumpSchema.parse(dump), null, 2)}\n`;
}

export function parseQuestBackupExport(serialized: string): QuestDump {
  const value: unknown = JSON.parse(serialized);
  const current = questDumpSchema.safeParse(value);
  if (current.success) {
    return current.data;
  }

  const preUnifiedOpen = preUnifiedOpenQuestDumpSchema.safeParse(value);
  if (preUnifiedOpen.success) {
    return questDumpSchema.parse({
      ...preUnifiedOpen.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(preUnifiedOpen.data.quests),
    });
  }

  const preActualFiles = preActualFilesQuestDumpSchema.safeParse(value);
  if (preActualFiles.success) {
    return questDumpSchema.parse({
      ...preActualFiles.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(preActualFiles.data.quests),
    });
  }

  const preSignoff = preSignoffQuestDumpSchema.safeParse(value);
  if (preSignoff.success) {
    return questDumpSchema.parse({
      ...preSignoff.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(preSignoff.data.quests),
    });
  }

  const preLeaseTtl = preLeaseTtlQuestDumpSchema.safeParse(value);
  if (preLeaseTtl.success) {
    return questDumpSchema.parse({
      ...preLeaseTtl.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(preLeaseTtl.data.quests),
    });
  }

  const preOpenBugDispatch = preOpenBugDispatchQuestDumpSchema.safeParse(value);
  if (preOpenBugDispatch.success) {
    return questDumpSchema.parse({
      ...preOpenBugDispatch.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(preOpenBugDispatch.data.quests),
    });
  }

  const preSessionAttribution = preSessionAttributionQuestDumpSchema.safeParse(value);
  if (preSessionAttribution.success) {
    return questDumpSchema.parse({
      ...preSessionAttribution.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(preSessionAttribution.data.quests),
    });
  }

  const preLease = preLeaseQuestDumpSchema.safeParse(value);
  if (preLease.success) {
    return questDumpSchema.parse({
      ...preLease.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(addLeases(preLease.data.quests)),
    });
  }

  const preCancel = preCancelQuestDumpSchema.safeParse(value);
  if (preCancel.success) {
    return questDumpSchema.parse({
      ...preCancel.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: normalizeImportedQuests(addLeases(preCancel.data.quests)),
    });
  }

  const inputVersion =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)["schema_version"]
      : undefined;
  if (typeof inputVersion === "number" && inputVersion > STORE_SCHEMA_VERSION) {
    const version = inputVersion;
    throw new Error(
      `[BACKUP_SCHEMA_NEWER] logical backup uses schema ${version}; this binary supports through ${STORE_SCHEMA_VERSION}. Upgrade Quest to a version that supports schema ${version}, then retry the restore. No data was changed.`,
    );
  }

  const legacy = legacyQuestDumpSchema.parse(value);
  return questDumpSchema.parse({
    ...legacy,
    schema_version: STORE_SCHEMA_VERSION,
    quests: legacy.quests.map((legacyQuest) => {
      const { branch: _branch, ...quest } = legacyQuest;
      return {
        ...quest,
        guild: null,
        lease_expires_at: leaseForImportedQuest(quest.status, quest.assignee, quest.updated_at),
        status: quest.status === "ready" ? "open" : quest.status,
      };
    }),
  });
}
