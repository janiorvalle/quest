import type { Event, EventAction, QuestScope } from "../schema";
import type { QuestStore } from "../store";

export interface EventQuery {
  readonly after_id?: number | undefined;
  readonly action?: EventAction | undefined;
  readonly actor?: string | undefined;
  readonly area?: string | undefined;
  readonly quest?: number | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

function scopedEventFilter(scope: QuestScope, query: EventQuery) {
  return {
    ...(scope.repo === null ? {} : { repo: scope.repo }),
    ...(query.quest === undefined ? {} : { quest_id: query.quest }),
    ...(query.after_id === undefined ? {} : { after_id: query.after_id }),
    ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.until === undefined ? {} : { until: query.until }),
    ...(query.actor === undefined ? {} : { actor: query.actor }),
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.area === undefined ? {} : { area: query.area }),
  };
}

export async function queryQuestEvents(
  store: QuestStore,
  scope: QuestScope,
  query: EventQuery,
): Promise<Event[]> {
  const events = await store.queryEvents(scopedEventFilter(scope, query));
  return events.sort((left, right) => left.id - right.id);
}
