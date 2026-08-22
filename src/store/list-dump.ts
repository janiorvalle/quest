import type { FederatedListDump } from "../schema";
import type { QuestStore } from "./port";

/**
 * Reads only quests and chains. Stores that expose the list snapshot never touch evidence or
 * events; a store without it keeps its full read, which is the local sqlite case and cheap.
 */
export async function readQuestListDump(store: QuestStore): Promise<FederatedListDump> {
  if (store.readFederatedSnapshot !== undefined) {
    return (await store.readFederatedSnapshot()).dump;
  }
  const { chains, quests, schema_version } = await store.exportAll();
  return { chains, quests, schema_version };
}
