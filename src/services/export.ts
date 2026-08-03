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

const preLeaseQuestSchema = questSchema.omit({ lease_expires_at: true });

const preSessionAttributionQuestDumpSchema = z.strictObject({
  schema_version: z.literal(4),
  quests: z.array(questSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventBaseSchema),
});

const preOpenBugDispatchQuestDumpSchema = z.strictObject({
  schema_version: z.literal(5),
  quests: z.array(questSchema),
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
    questSchema.omit({ guild: true, lease_expires_at: true }).extend({
      branch: questSchema.shape.pr,
    }),
  ),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(preCancelEventSchema),
});

function leaseForImportedQuest(
  status: QuestDump["quests"][number]["status"],
  assignee: string | null,
  updatedAt: string,
): string | null {
  return status === "accepted" && assignee !== null ? leaseExpiry(updatedAt) : null;
}

function addLeases(quests: readonly z.infer<typeof preLeaseQuestSchema>[]): QuestDump["quests"] {
  return quests.map((quest) => ({
    ...quest,
    lease_expires_at: leaseForImportedQuest(quest.status, quest.assignee, quest.updated_at),
  }));
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

  const preOpenBugDispatch = preOpenBugDispatchQuestDumpSchema.safeParse(value);
  if (preOpenBugDispatch.success) {
    return questDumpSchema.parse({
      ...preOpenBugDispatch.data,
      schema_version: STORE_SCHEMA_VERSION,
    });
  }

  const preSessionAttribution = preSessionAttributionQuestDumpSchema.safeParse(value);
  if (preSessionAttribution.success) {
    return questDumpSchema.parse({
      ...preSessionAttribution.data,
      schema_version: STORE_SCHEMA_VERSION,
    });
  }

  const preLease = preLeaseQuestDumpSchema.safeParse(value);
  if (preLease.success) {
    return questDumpSchema.parse({
      ...preLease.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: addLeases(preLease.data.quests),
    });
  }

  const preCancel = preCancelQuestDumpSchema.safeParse(value);
  if (preCancel.success) {
    return questDumpSchema.parse({
      ...preCancel.data,
      schema_version: STORE_SCHEMA_VERSION,
      quests: addLeases(preCancel.data.quests),
    });
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
      };
    }),
  });
}
