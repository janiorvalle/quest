import { computeQaQueueFromDump, type QaQueue, type QaSession, type QaShell } from "../domain/qa";
import type { QuestScope } from "../schema";
import type { QuestStore } from "../store";

export async function getQaQueue(
  store: QuestStore,
  scope: QuestScope,
  shell: QaShell | undefined = undefined,
): Promise<QaQueue> {
  if (scope.repo !== null) {
    const scopedStore = store.forRepository?.(scope.repo) ?? store;
    return computeQaQueueFromDump(await scopedStore.exportAll(), scope.repo, shell);
  }

  const repositories = (await store.stats({ repo: null })).repos.map(({ repo }) => repo);
  const queues = await Promise.all(
    repositories.map(async (repository) => {
      const scopedStore = store.forRepository?.(repository) ?? store;
      return computeQaQueueFromDump(await scopedStore.exportAll(), repository, shell);
    }),
  );
  return mergeQaQueues(queues);
}

function mergeQaQueues(queues: readonly QaQueue[]): QaQueue {
  const sessions = queues
    .flatMap(({ sessions: queueSessions }) => queueSessions)
    .sort(
      (left, right) =>
        Date.parse(left.oldest_at) - Date.parse(right.oldest_at) ||
        (left.ids[0] ?? 0) - (right.ids[0] ?? 0) ||
        left.repo.localeCompare(right.repo),
    )
    .map((session, index): QaSession => ({ ...session, group: index + 1 }));
  const quests = queues.reduce((total, queue) => total + queue.summary.quests, 0);
  return {
    footer:
      queues[0]?.footer ??
      'Found a problem? use quest --repo <repo> reopen <id> --notes "<what failed>"',
    message: sessions.length === 0 ? "Nothing awaiting sign-off." : null,
    sessions,
    summary: { quests, sessions: sessions.length },
  };
}
