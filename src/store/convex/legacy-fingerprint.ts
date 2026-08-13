import type { Quest, QuestDump } from "../../schema";

type LegacyQuest = Omit<Quest, "status"> & { readonly status: Quest["status"] | "ready" };
type LegacyQuestDump = Omit<QuestDump, "quests" | "schema_version"> & {
  readonly quests: readonly LegacyQuest[];
  readonly schema_version: 9;
};

function legacyStatus(quest: Quest): LegacyQuest["status"] {
  if (quest.status !== "open") {
    return quest.status;
  }
  return quest.kind === "task" || quest.verdict === "actionable" ? "ready" : "open";
}

/** Recreates the v9 snapshot shape so a rollout cannot strand an existing restore or fence. */
export function legacyReadySnapshot(snapshot: QuestDump): LegacyQuestDump {
  return {
    ...snapshot,
    schema_version: 9,
    quests: snapshot.quests.map((quest) => ({ ...quest, status: legacyStatus(quest) })),
  };
}
