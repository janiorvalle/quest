import type { Event, QuestDump, QuestScope } from "../schema";
import type { QuestStore } from "../store";
import { type QuestDetail, showQuestDetailFromDump } from "./query";

export interface QuestBrief extends QuestDetail {
  readonly events: readonly Event[];
}

export function compileQuestBriefFromDump(
  dump: QuestDump,
  scope: QuestScope,
  id: number,
): QuestBrief {
  const detail = showQuestDetailFromDump(dump, scope, id);
  const events = dump.events.filter((event) => event.quest_id === detail.quest.id);
  return { ...detail, events: events.sort((left, right) => left.id - right.id) };
}

/**
 * The resumable context package (VISION pillar 2): everything a cold agent
 * needs to start productive on a quest in one read — detail, chain
 * neighborhood, evidence manifest, and the full per-quest event history
 * (oldest first, so the story reads forward).
 */
export async function compileQuestBrief(
  store: QuestStore,
  scope: QuestScope,
  id: number,
): Promise<QuestBrief> {
  return compileQuestBriefFromDump(await store.exportAll(), scope, id);
}
