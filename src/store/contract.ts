import { describe, expect, test } from "bun:test";
import type {
  BlobStore,
  Chain,
  Event,
  NewEvidence,
  NewQuest,
  Quest,
  QuestDump,
  QuestStatus,
  QuestStore,
  QuestTransition,
  Sha256,
} from "../index";
import { eventSchema, questDumpSchema, questSchema, sha256Schema } from "../schema";

export type QuestStoreHarness = {
  store: QuestStore;
  /** Resolves a requested actor to the identity the backend records for this harness. */
  resolveActor?: (requestedActor: string) => string;
  /** Makes the next event append reject after its domain mutation has been prepared. */
  failNextEventAppend: () => Promise<void>;
  /** Waits until mutations already submitted to the store have reached registered watchers. */
  flushWatch: () => Promise<void>;
  close: () => Promise<void>;
};

export type ActorResolver = (requestedActor: string) => string;

export type QuestStoreFactory = () => Promise<QuestStoreHarness>;

export type BlobStoreHarness = {
  store: BlobStore;
  /** Makes the next blob publication reject after its content address has been prepared. */
  failNextPublish: () => Promise<void>;
  close: () => Promise<void>;
};

export type BlobStoreFactory = () => Promise<BlobStoreHarness>;

type ContractScenario = {
  name: string;
  run: (factory: QuestStoreFactory) => Promise<void>;
};

export type ContractFailure = {
  scenario: string;
  message: string;
};

const actor = "contract/tester";
const identityActor: ActorResolver = (requestedActor) => requestedActor;

const scenarios = [
  { name: "claim races have exactly one winner", run: verifyClaimRace },
  { name: "illegal transitions change neither state nor events", run: verifyIllegalTransition },
  { name: "sign-off requires completion and appends repeat attestations", run: verifySignoff },
  {
    name: "sign-off batches commit attestations and evidence atomically",
    run: verifySignoffBatchAtomicity,
  },
  { name: "chain invariants are enforced inside the write boundary", run: verifyChainInvariants },
  { name: "backfilled adds enforce kind and verdict validity", run: verifyBackfilledAdds },
  { name: "events and state changes commit together", run: verifyEventStateAtomicity },
  { name: "event queries support every individual filter", run: verifyEventFilters },
  { name: "event queries compose filters", run: verifyCombinedEventFilters },
  {
    name: "event query ranges include offset-equivalent endpoints",
    run: verifyEventRangeEndpoints,
  },
  { name: "event query ID cursors return only newer events", run: verifyEventCursor },
  { name: "event queries return events in stable ID order", run: verifyEventOrdering },
  { name: "display IDs are unique and monotonic", run: verifyMonotonicDisplayIds },
  { name: "exportAll survives a schema-validated JSON round trip", run: verifyExportRoundTrip },
  { name: "watch registration and unsubscribe honor snapshot semantics", run: verifyWatch },
] satisfies readonly ContractScenario[];

const blobScenarios = [
  { name: "put is content-addressed and idempotent", run: verifyBlobContentAddressing },
  { name: "failed publication leaves no readable blob", run: verifyBlobPublishAtomicity },
] satisfies readonly {
  name: string;
  run: (factory: BlobStoreFactory) => Promise<void>;
}[];

export function defineQuestStoreContract(name: string, factory: QuestStoreFactory): void {
  describe(name, () => {
    for (const scenario of scenarios) {
      test.serial(scenario.name, () => scenario.run(factory));
    }
  });
}

export async function inspectQuestStoreContract(
  factory: QuestStoreFactory,
): Promise<ContractFailure[]> {
  const failures: ContractFailure[] = [];
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (error: unknown) {
      failures.push({
        scenario: scenario.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

export function defineBlobStoreContract(name: string, factory: BlobStoreFactory): void {
  describe(name, () => {
    for (const scenario of blobScenarios) {
      test.serial(scenario.name, () => scenario.run(factory));
    }
  });
}

export async function inspectBlobStoreContract(
  factory: BlobStoreFactory,
): Promise<ContractFailure[]> {
  const failures: ContractFailure[] = [];
  for (const scenario of blobScenarios) {
    try {
      await scenario.run(factory);
    } catch (error: unknown) {
      failures.push({
        scenario: scenario.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

async function verifyClaimRace(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store, resolveActor) => {
    const quest = await store.addQuest(taskInput("claim race"));
    const attempts = await Promise.all(
      ["contract/one", "contract/two"].map(async (requestedOwner) => {
        const owner = resolveActor(requestedOwner);
        return {
          owner,
          result: await store.acceptQuest({ id: quest.id, owner }),
        };
      }),
    );
    const accepted = attempts.filter(({ result }) => result.outcome === "accepted");
    const conflicts = attempts.filter(({ result }) => result.outcome === "conflict");

    requireContract(accepted.length === 1, "claim race must produce exactly one accepted result");
    requireContract(conflicts.length === 1, "claim race must produce exactly one conflict result");
    const winner = accepted[0];
    requireContract(winner !== undefined, "claim race winner must be observable");
    requireContract(
      winner.result.outcome === "accepted" &&
        winner.result.quest.status === "accepted" &&
        winner.result.quest.assignee === winner.owner,
      "claim winner must be assigned to the owner submitted by the winning call",
    );
    const stored = await store.getQuest(quest.id);
    requireContract(stored !== null, "claimed quest must remain readable");
    requireContract(
      stored.status === "accepted" && stored.assignee === winner.owner,
      "stored quest must agree with the winning owner and accepted state",
    );
    expect(conflicts[0]?.result.quest).toEqual(stored);
    await requireEventState(store, quest.id, "accepted", ["add", "accept"]);

    const openBug = await store.addQuest(bugInput("open bug claim"));
    const openBugAcceptance = await store.acceptQuest({
      id: openBug.id,
      owner: resolveActor(actor),
    });
    requireContract(
      openBugAcceptance.outcome === "accepted" &&
        openBugAcceptance.quest.status === "accepted" &&
        openBugAcceptance.quest.assignee === resolveActor(actor),
      "an open bug must be directly claimable",
    );
    await requireEventState(store, openBug.id, "accepted", ["add", "accept"]);
    const abandonedOpenBug = await store.transition(openBug.id, {
      action: "abandon",
      actor: resolveActor(actor),
    });
    requireContract(
      abandonedOpenBug.status === "open" && abandonedOpenBug.verdict === null,
      "abandoning an untriaged bug must return it to open",
    );
    await store.acceptQuest({ id: openBug.id, owner: resolveActor(actor) });
    await store.transition(openBug.id, {
      action: "turnin",
      actor: resolveActor(actor),
      pr: "open-bug",
      session_guild: null,
    });
    const reopenedOpenBug = await store.transition(openBug.id, {
      action: "reopen",
      actor: resolveActor(actor),
      notes: "retest the untriaged bug",
    });
    requireContract(
      reopenedOpenBug.status === "open" && reopenedOpenBug.verdict === null,
      "reopening an untriaged bug must preserve its open dispatch state",
    );
  });
}

async function verifyIllegalTransition(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store, resolveActor) => {
    const quest = await store.addQuest(taskInput("illegal transition"));
    const questBefore = snapshotQuest(quest);
    const eventsBefore = snapshotEvents(await store.events(quest.id));
    const actor = resolveActor("contract/tester");

    for (const [transition, code] of [
      [{ action: "turnin", actor, pr: null, session_guild: null }, "TURNIN_INVALID_STATE"],
      [{ action: "complete", actor }, "COMPLETE_INVALID_STATE"],
      [{ action: "reopen", actor, notes: "invalid state" }, "REOPEN_INVALID_STATE"],
    ] satisfies ReadonlyArray<readonly [QuestTransition, string]>) {
      let rejection: unknown;
      try {
        await store.transition(quest.id, transition);
      } catch (error: unknown) {
        rejection = error;
      }
      requireContract(
        rejection instanceof Error &&
          rejection.message.includes(`[${code}] quest ${quest.id} is ready;`),
        `${transition.action} from ready must reject with ${code}`,
      );
    }
    expect(await store.getQuest(quest.id)).toEqual(questBefore);
    expect(await store.events(quest.id)).toEqual(eventsBefore);

    const accepted = await store.acceptQuest({ id: quest.id, owner: actor });
    requireContract(accepted.outcome === "accepted", "illegal transition fixture must be accepted");
    const acceptedBefore = snapshotQuest(accepted.quest);
    const acceptedEventsBefore = snapshotEvents(await store.events(quest.id));
    for (const [transition, code] of [
      [{ action: "complete", actor: resolveActor("contract/other") }, "COMPLETE_INVALID_STATE"],
      [
        { action: "reopen", actor: resolveActor("contract/other"), notes: "invalid state" },
        "REOPEN_INVALID_STATE",
      ],
    ] satisfies ReadonlyArray<readonly [QuestTransition, string]>) {
      let rejection: unknown;
      try {
        await store.transition(quest.id, transition);
      } catch (error: unknown) {
        rejection = error;
      }
      requireContract(
        rejection instanceof Error &&
          rejection.message.includes(`[${code}] quest ${quest.id} is accepted;`),
        `${transition.action} from accepted must reject with ${code} before lease validation`,
      );
    }
    expect(await store.getQuest(quest.id)).toEqual(acceptedBefore);
    expect(await store.events(quest.id)).toEqual(acceptedEventsBefore);
  });
}

async function verifySignoff(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store, resolveActor) => {
    const quest = await store.addQuest(taskInput("sign-off"));
    let rejection: unknown;
    try {
      await store.transition(quest.id, {
        action: "signoff",
        actor: resolveActor("qa/reviewer"),
        notes: null,
        session_guild: null,
      });
    } catch (error: unknown) {
      rejection = error;
    }
    requireContract(
      rejection instanceof Error &&
        rejection.message.includes(
          `[SIGNOFF_NOT_COMPLETE] quest ${quest.id} is ready; sign-off applies only after review, merge, and completion`,
        ),
      "sign-off on a non-complete quest must reject with its stable next-step message",
    );
    await requireRejection(
      store.addEvidence({
        quest_id: quest.id,
        sha256: "e".repeat(64),
        filename: "premature-signoff.txt",
        kind: "doc",
        stage: "signoff",
        added_by: resolveActor("qa/reviewer"),
      }),
      "sign-off evidence must reject before the quest is complete",
    );
    expect(await store.events(quest.id)).toHaveLength(1);

    const owner = resolveActor(actor);
    await store.acceptQuest({ id: quest.id, owner });
    await store.transition(quest.id, {
      action: "turnin",
      actor: owner,
      pr: null,
      session_guild: null,
    });
    await store.transition(quest.id, {
      action: "complete",
      actor: owner,
      session_guild: null,
    });

    const first = await store.transition(quest.id, {
      action: "signoff",
      actor: resolveActor("qa/reviewer"),
      notes: "first pass",
      session_guild: null,
    });
    requireContract(first.status === "complete", "sign-off must leave the quest complete");
    const second = await store.transition(quest.id, {
      action: "signoff",
      actor: resolveActor("qa/reviewer"),
      notes: "repeat pass",
      session_guild: null,
    });
    requireContract(second.status === "complete", "repeat sign-off must leave the quest complete");
    const signoffEvidence = await store.addEvidence({
      quest_id: quest.id,
      sha256: "d".repeat(64),
      filename: "signoff.txt",
      kind: "doc",
      stage: "signoff",
      added_by: resolveActor("qa/reviewer"),
    });
    expect(signoffEvidence).toMatchObject({
      added_by: resolveActor("qa/reviewer"),
      stage: "signoff",
    });
    const signoffs = (await store.events(quest.id)).filter((event) => event.action === "signoff");
    requireContract(signoffs.length === 2, "repeat sign-off must append another event");
    expect(signoffs.map(({ actor }) => actor)).toEqual([
      resolveActor("qa/reviewer"),
      resolveActor("qa/reviewer"),
    ]);
    expect(signoffs.map((event) => event.detail)).toEqual([
      expect.objectContaining({ action: "signoff", notes: "first pass" }),
      expect.objectContaining({ action: "signoff", notes: "repeat pass" }),
    ]);
  });
}

async function verifySignoffBatchAtomicity(factory: QuestStoreFactory): Promise<void> {
  await withHarness(factory, async (harness) => {
    const { store } = harness;
    const resolveActor = harness.resolveActor ?? identityActor;
    const owner = resolveActor(actor);
    const reviewer = resolveActor("qa/reviewer");
    const completedQuests: Quest[] = [];

    for (const title of ["batch sign-off one", "batch sign-off two"]) {
      const quest = await store.addQuest(taskInput(title));
      await store.acceptQuest({ id: quest.id, owner });
      await store.transition(quest.id, {
        action: "turnin",
        actor: owner,
        pr: null,
        session_guild: null,
      });
      completedQuests.push(
        await store.transition(quest.id, {
          action: "complete",
          actor: owner,
          session_guild: null,
        }),
      );
    }

    const input = {
      ids: completedQuests.map(({ id }) => id),
      transition: {
        action: "signoff" as const,
        actor: reviewer,
        notes: "batch contract pass",
        session_guild: null,
      },
      evidence: completedQuests.map(({ id }, index) => ({
        quest_id: id,
        sha256: String(index + 1).repeat(64),
        filename: `batch-${index + 1}.txt`,
        kind: "doc" as const,
        stage: "signoff" as const,
        added_by: reviewer,
        session_guild: null,
      })),
    };
    const before = snapshotDump(await store.exportAll());
    await harness.failNextEventAppend();
    await requireRejection(
      store.signoffBatch(input),
      "an injected batch sign-off event failure must roll back every quest and evidence row",
    );
    expect(await store.exportAll()).toEqual(before);

    const result = await store.signoffBatch(input);
    requireContract(
      result.quests.map(({ id }) => id).join(",") === input.ids.join(","),
      "a successful sign-off batch must return every requested quest",
    );
    requireContract(
      result.evidence.length === input.evidence.length,
      "batch evidence must be returned",
    );
    for (const quest of completedQuests) {
      const signoffs = (await store.events(quest.id)).filter((event) => event.action === "signoff");
      requireContract(
        signoffs.length === 1,
        "a successful batch must append one sign-off per quest",
      );
      requireContract(
        (await store.getQuest(quest.id))?.status === "complete",
        "a successful batch must leave each quest complete",
      );
    }
  });
}

async function verifyChainInvariants(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store, resolveActor) => {
    const first = await store.addQuest(taskInput("cycle one"));
    const second = await store.addQuest(taskInput("cycle two"));
    const third = await store.addQuest(taskInput("cycle three"));

    const firstLink = requires(first, second);
    await requireAdded(store, firstLink, resolveActor);
    const beforeReplay = snapshotDump(await store.exportAll());
    const replay = await store.addChainLink({ link: firstLink, actor: resolveActor(actor) });
    requireContract(replay.outcome === "exists", "replayed chain must return exists");
    expect(await store.exportAll()).toEqual(beforeReplay);

    const missingTarget = {
      quest_id: first.id,
      target_id: 99_999,
      type: "requires",
    } satisfies Chain;
    await requireRejection(
      store.addChainLink({ link: missingTarget, actor: resolveActor(actor) }),
      "chain with a missing target must reject",
    );
    expect(await store.exportAll()).toEqual(beforeReplay);

    const missingSource = {
      quest_id: 99_998,
      target_id: first.id,
      type: "requires",
    } satisfies Chain;
    await requireRejection(
      store.addChainLink({ link: missingSource, actor: resolveActor(actor) }),
      "chain with a missing source must reject",
    );
    expect(await store.exportAll()).toEqual(beforeReplay);
    await requireRejection(
      store.removeChainLink({ link: missingTarget, actor: resolveActor(actor) }),
      "chain removal with a missing target must reject",
    );
    await requireRejection(
      store.removeChainLink({ link: missingSource, actor: resolveActor(actor) }),
      "chain removal with a missing source must reject",
    );
    expect(await store.exportAll()).toEqual(beforeReplay);

    await requireAdded(store, requires(second, third), resolveActor);
    const proposed = requires(third, first);
    const beforeCycle = snapshotDump(await store.exportAll());
    const result = await store.addChainLink({ link: proposed, actor: resolveActor(actor) });
    requireContract(result.outcome === "cycle", "closing a deep requires cycle must be rejected");
    requireContract(
      result.outcome === "cycle" &&
        result.path.join(",") === [third.id, first.id, second.id, third.id].join(","),
      "cycle rejection must return the exact offending path",
    );
    expect(await store.exportAll()).toEqual(beforeCycle);

    const removed = await store.removeChainLink({ link: firstLink, actor: resolveActor(actor) });
    requireContract(removed.outcome === "removed", "an existing exact chain must be removed");
    const afterRemoval = snapshotDump(await store.exportAll());
    requireContract(
      !afterRemoval.chains.some((link) => sameChain(link, firstLink)),
      "removed chains must no longer be exported",
    );
    const removalReplay = await store.removeChainLink({
      link: firstLink,
      actor: resolveActor(actor),
    });
    requireContract(removalReplay.outcome === "missing", "replayed removal must return missing");
    expect(await store.exportAll()).toEqual(afterRemoval);
    await requireAdded(store, firstLink, resolveActor);

    const concurrentFirst = await store.addQuest(taskInput("concurrent cycle one"));
    const concurrentSecond = await store.addQuest(taskInput("concurrent cycle two"));
    const concurrentThird = await store.addQuest(taskInput("concurrent cycle three"));
    const concurrentBase = requires(concurrentFirst, concurrentSecond);
    const concurrentForward = requires(concurrentSecond, concurrentThird);
    const concurrentClosing = requires(concurrentThird, concurrentFirst);
    await requireAdded(store, concurrentBase, resolveActor);

    const concurrentResults = await Promise.all([
      store.addChainLink({ link: concurrentForward, actor: resolveActor(actor) }),
      store.addChainLink({ link: concurrentClosing, actor: resolveActor(actor) }),
    ]);
    requireContract(
      concurrentResults.filter(({ outcome }) => outcome === "added").length === 1 &&
        concurrentResults.filter(({ outcome }) => outcome === "cycle").length === 1,
      "overlapping cycle-forming links must produce exactly one add and one cycle result",
    );
    const concurrentLinks = (await store.exportAll()).chains.filter(
      ({ quest_id, target_id }) =>
        [concurrentFirst.id, concurrentSecond.id, concurrentThird.id].includes(quest_id) &&
        [concurrentFirst.id, concurrentSecond.id, concurrentThird.id].includes(target_id),
    );
    requireContract(
      concurrentLinks.length === 2 &&
        concurrentLinks.some((link) => sameChain(link, concurrentBase)) &&
        concurrentLinks.filter(
          (link) => sameChain(link, concurrentForward) || sameChain(link, concurrentClosing),
        ).length === 1,
      "the committed graph must contain the base and only one competing link",
    );
  });
}

async function verifyBackfilledAdds(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store) => {
    const valid = await store.addQuest({
      ...bugInput("historical complete"),
      status: "complete",
      verdict: "actionable",
    });
    await requireEventState(store, valid.id, "complete", ["add"]);
    const beforeRejections = snapshotDump(await store.exportAll());

    await requireRejection(
      store.addQuest({ ...taskInput("invalid historical task"), status: "open" }),
      "task backfill at open must reject",
    );
    expect(await store.exportAll()).toEqual(beforeRejections);
    await requireRejection(
      store.addQuest({
        ...bugInput("invalid historical verdict"),
        status: "ready",
        verdict: "not-reproduced",
      }),
      "ready bug backfill with a non-actionable verdict must reject",
    );
    expect(await store.exportAll()).toEqual(beforeRejections);
    const next = await store.addQuest(taskInput("after invalid backfill"));
    requireContract(next.id === valid.id + 1, "invalid backfills must not consume display IDs");
    const directlyClaimed = await store.addQuest({
      ...bugInput("directly claimed bug backfill"),
      assignee: actor,
      status: "accepted",
    });
    await requireEventState(store, directlyClaimed.id, "accepted", ["add"]);
  });
}

async function verifyEventStateAtomicity(factory: QuestStoreFactory): Promise<void> {
  await withHarness(factory, async (harness) => {
    const { store } = harness;
    const resolveActor = harness.resolveActor ?? identityActor;
    const baseline = await store.addQuest(taskInput("atomicity baseline"));
    await requireEventState(store, baseline.id, "ready", ["add"]);
    await requireEventRollback(
      harness,
      () => store.addQuest(taskInput("failed atomic add")),
      "an injected addQuest event failure must reject the mutation",
    );

    const added = await store.addQuest(taskInput("event atomicity"));
    requireContract(
      added.id === baseline.id + 1,
      "failed addQuest must not consume the display ID before the next successful add",
    );
    await requireEventState(store, added.id, "ready", ["add"]);

    await requireEventRollback(
      harness,
      () => store.acceptQuest({ id: added.id, owner: resolveActor(actor) }),
      "an injected acceptQuest event failure must reject the mutation",
    );
    const accepted = await store.acceptQuest({ id: added.id, owner: resolveActor(actor) });
    requireContract(accepted.outcome === "accepted", "valid claim must succeed");
    await requireEventState(store, added.id, "accepted", ["add", "accept"]);

    const turnIn = () =>
      store.transition(added.id, {
        action: "turnin",
        actor: resolveActor(actor),
        pr: "42",
        session_guild: null,
      });
    await requireEventRollback(
      harness,
      turnIn,
      "an injected event append failure must reject the mutation",
    );
    await turnIn();
    await requireEventState(store, added.id, "turned_in", ["add", "accept", "turnin"]);

    const target = await store.addQuest(taskInput("atomic link target"));
    requireContract(target.id === added.id + 1, "failed addQuest must not consume a display ID");
    const link = requires(target, added);
    await requireEventRollback(
      harness,
      () => store.addChainLink({ link, actor: resolveActor(actor) }),
      "an injected addChainLink event failure must reject the mutation",
    );
    await requireAdded(store, link, resolveActor);
    await requireEventState(store, target.id, "ready", ["add", "chain"]);
    await requireEventRollback(
      harness,
      () => store.removeChainLink({ link, actor: resolveActor(actor) }),
      "an injected removeChainLink event failure must reject the mutation",
    );
    await requireEventState(store, target.id, "ready", ["add", "chain"]);

    const evidence: NewEvidence = {
      quest_id: added.id,
      sha256: "b".repeat(64),
      filename: "atomicity.log",
      kind: "log",
      stage: "fix",
      added_by: resolveActor(actor),
    };
    await requireEventRollback(
      harness,
      () => store.addEvidence(evidence),
      "an injected addEvidence event failure must reject the mutation",
    );
    await store.addEvidence(evidence);
    await requireEventState(store, added.id, "turned_in", ["add", "accept", "turnin", "update"]);

    const missingOwnerEvidence: NewEvidence = {
      ...evidence,
      quest_id: 99_999,
      filename: "missing-owner.log",
    };
    const beforeMissingOwner = snapshotDump(await store.exportAll());
    await requireRejection(
      store.addEvidence(missingOwnerEvidence),
      "evidence with a missing owning quest must reject",
    );
    expect(await store.exportAll()).toEqual(beforeMissingOwner);

    const duplicateBug = await store.addQuest(bugInput("duplicate verdict atomicity"));
    const duplicateVerdict = () =>
      store.transition(duplicateBug.id, {
        action: "verdict",
        actor: resolveActor(actor),
        verdict: "duplicate",
        notes: null,
        retest: false,
        duplicate_of: target.id,
      });
    await requireEventRollback(
      harness,
      duplicateVerdict,
      "an injected duplicate verdict event failure must roll back its quest and chain link",
    );
    const droppedDuplicate = await duplicateVerdict();
    requireContract(
      droppedDuplicate.status === "dropped" && droppedDuplicate.verdict === "duplicate",
      "duplicate verdict must update the quest",
    );
    await requireEventState(store, duplicateBug.id, "dropped", ["add", "verdict"]);

    const finalDump = await store.exportAll();
    requireContract(
      finalDump.quests.length === 4 &&
        finalDump.chains.length === 2 &&
        finalDump.evidence.length === 1 &&
        finalDump.events.length === 9 &&
        finalDump.chains.some(
          (link) =>
            link.quest_id === duplicateBug.id &&
            link.target_id === target.id &&
            link.type === "duplicate-of",
        ),
      "successful mutations after injected failures must persist complete state and events",
    );
  });
}

async function verifyEventFilters(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store, resolveActor) => {
    const fixture = await createEventQueryFixture(store, resolveActor);
    const firstAdd = eventByAction(fixture.firstEvents, "add");
    const lastEvent = (await store.queryEvents({})).reduce(
      (latest, candidate) => (candidate.id > latest.id ? candidate : latest),
      firstAdd,
    );

    expect(
      (await store.queryEvents({ repo: "contract-alpha" })).map(({ quest_id }) => quest_id),
    ).toEqual([fixture.first.id, fixture.first.id]);
    expect(
      (await store.queryEvents({ quest_id: fixture.first.id })).map(({ quest_id }) => quest_id),
    ).toEqual([fixture.first.id, fixture.first.id]);
    const matchingActor = resolveActor("contract/query");
    const allEvents = await store.queryEvents({});
    expect(
      (await store.queryEvents({ actor: matchingActor })).map(({ quest_id }) => quest_id),
    ).toEqual(
      allEvents
        .filter(({ actor: eventActor }) => eventActor === matchingActor)
        .map(({ quest_id }) => quest_id),
    );
    expect((await store.queryEvents({ action: "update" })).map(({ quest_id }) => quest_id)).toEqual(
      [fixture.first.id, fixture.second.id],
    );
    expect((await store.queryEvents({ area: "alpha" })).map(({ quest_id }) => quest_id)).toEqual([
      fixture.first.id,
      fixture.first.id,
    ]);
    requireContract(
      (await store.queryEvents({ since: firstAdd.at })).some(({ id }) => id === firstAdd.id),
      "since must include an event at the range start",
    );
    requireContract(
      (await store.queryEvents({ until: firstAdd.at })).some(({ id }) => id === firstAdd.id),
      "until must include an event at the range end",
    );
    expect(await store.queryEvents({ until: shiftTimestamp(firstAdd.at, -1) })).toEqual([]);
    expect(await store.queryEvents({ since: shiftTimestamp(lastEvent.at, 1) })).toEqual([]);
  });
}

async function verifyCombinedEventFilters(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store, resolveActor) => {
    const fixture = await createEventQueryFixture(store, resolveActor);
    const firstUpdate = eventByAction(fixture.firstEvents, "update");
    const events = await store.queryEvents({
      repo: "contract-alpha",
      since: firstUpdate.at,
      until: firstUpdate.at,
      actor: resolveActor("contract/query"),
      action: "update",
      area: "alpha",
      quest_id: fixture.first.id,
    });

    expect(events).toEqual([firstUpdate]);
  });
}

async function verifyEventRangeEndpoints(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store) => {
    const fixture = await createEventQueryFixture(store);
    const firstAdd = eventByAction(fixture.firstEvents, "add");
    const sameInstantWithOffset = offsetEquivalent(firstAdd.at);
    const events = await store.queryEvents({
      since: sameInstantWithOffset,
      until: sameInstantWithOffset,
    });

    requireContract(
      events.some(({ id }) => id === firstAdd.id),
      "offset-differing timestamps for the same instant must include the boundary event",
    );
  });
}

async function verifyEventCursor(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store) => {
    const fixture = await createEventQueryFixture(store);
    const firstAdd = eventByAction(fixture.firstEvents, "add");
    const allEvents = await store.queryEvents({});
    const expectedAfterCursor = allEvents.filter(({ id }) => id > firstAdd.id);

    expect(await store.queryEvents({ after_id: firstAdd.id })).toEqual(expectedAfterCursor);
    expect(await store.queryEvents({ after_id: firstAdd.id, repo: "contract-alpha" })).toEqual(
      expectedAfterCursor.filter(({ quest_id }) => quest_id === fixture.first.id),
    );

    const lastEvent = allEvents.at(-1);
    requireContract(lastEvent !== undefined, "cursor fixture must contain events");
    expect(await store.queryEvents({ after_id: lastEvent.id })).toEqual([]);
  });
}

async function verifyEventOrdering(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store) => {
    await createEventQueryFixture(store);
    const events = await store.queryEvents({});
    requireContract(events.length > 0, "event ordering must include stored events");
    const ids = events.map(({ id }) => id);
    const sortedIds = [...ids].sort((left, right) => left - right);

    expect(ids).toEqual(sortedIds);
  });
}

type EventQueryFixture = {
  first: Quest;
  second: Quest;
  firstEvents: Event[];
};

async function createEventQueryFixture(
  store: QuestStore,
  resolveActor: ActorResolver = identityActor,
): Promise<EventQueryFixture> {
  const first = await store.addQuest({
    ...taskInput("event query first"),
    repo: "contract-alpha",
    area: "alpha",
  });
  const second = await store.addQuest({
    ...taskInput("event query second"),
    repo: "contract-beta",
    area: "beta",
  });
  await store.transition(first.id, {
    action: "update",
    actor: resolveActor("contract/query"),
    changes: { title: "event query first updated" },
  });
  await store.transition(second.id, {
    action: "update",
    actor: resolveActor("contract/other"),
    changes: { title: "event query second updated" },
  });

  return {
    first,
    second,
    firstEvents: await store.events(first.id),
  };
}

async function verifyMonotonicDisplayIds(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store) => {
    const quests = await Promise.all([
      store.addQuest(taskInput("display one")),
      store.addQuest(taskInput("display two")),
      store.addQuest(taskInput("display three")),
    ]);
    const ids = quests.map((quest) => quest.id).sort((left, right) => left - right);
    requireContract(
      ids.length === 3 && ids[0] !== undefined && ids[1] === ids[0] + 1 && ids[2] === ids[1] + 1,
      "concurrent adds must allocate three consecutive display IDs exactly once",
    );
  });
}

async function verifyExportRoundTrip(factory: QuestStoreFactory): Promise<void> {
  await withStore(factory, async (store, resolveActor) => {
    const first = await store.addQuest(taskInput("export one"));
    const second = await store.addQuest(taskInput("export two"));
    await requireAdded(store, requires(second, first), resolveActor);
    await store.addEvidence({
      quest_id: first.id,
      sha256: "a".repeat(64),
      filename: "proof.log",
      kind: "log",
      stage: "fix",
      added_by: resolveActor(actor),
    });

    const dump = await store.exportAll();
    const parsed = questDumpSchema.parse(JSON.parse(JSON.stringify(dump)));
    expect(parsed).toEqual(dump);
    requireContract(
      dump.quests.length === 2 &&
        dump.chains.length === 1 &&
        dump.evidence.length === 1 &&
        dump.events.length === 4,
      "exportAll must include all stored entities and their mutation events",
    );
  });
}

async function verifyWatch(factory: QuestStoreFactory): Promise<void> {
  await withHarness(factory, async ({ store, flushWatch }) => {
    const emissions: Quest[][] = [];
    const filter = { repo: "contract" };
    const existing = await store.addQuest(taskInput("existing watched quest"));
    await store.addQuest({ ...taskInput("outside watch filter"), repo: "outside" });
    const subscription = await store.watch(filter, (quests) => {
      emissions.push(snapshotQuests(quests));
    });
    await flushWatch();
    requireContract(
      emissions.length > 0,
      "watch registration must emit the current filtered snapshot",
    );
    expect(questIds(emissions.at(-1) ?? [])).toEqual([existing.id]);
    const registrationEmissionCount = emissions.length;

    const added = await store.addQuest(taskInput("watched mutation"));
    await flushWatch();
    requireContract(
      emissions.length > registrationEmissionCount,
      "a registered watcher must observe a later mutation",
    );
    expect(questIds(emissions.at(-1) ?? [])).toEqual([existing.id, added.id]);

    const emissionCount = emissions.length;
    await subscription.unsubscribe();
    await subscription.unsubscribe();
    await store.addQuest(taskInput("after unsubscribe"));
    await flushWatch();
    requireContract(
      emissions.length === emissionCount,
      "an idempotently unsubscribed watcher must receive no later snapshots",
    );
  });
}

async function verifyBlobContentAddressing(factory: BlobStoreFactory): Promise<void> {
  await withBlobStore(factory, async ({ store }) => {
    const bytes = new TextEncoder().encode("contract blob");
    const expected = contentHash(bytes);
    const first = await store.put(bytes);
    const second = await store.put(bytes);

    requireContract(first === expected, "put must return the lowercase SHA-256 content address");
    requireContract(second === expected, "repeating identical bytes must return the same address");
    requireContract(await store.has(expected), "published blob must be observable through has");
    expect(await store.get(expected)).toEqual(bytes);
  });
}

async function verifyBlobPublishAtomicity(factory: BlobStoreFactory): Promise<void> {
  await withBlobStore(factory, async ({ store, failNextPublish }) => {
    const bytes = new TextEncoder().encode(`failed contract blob ${crypto.randomUUID()}`);
    const expected = contentHash(bytes);

    await failNextPublish();
    await requireRejection(
      store.put(bytes),
      "an injected blob publication failure must reject the put",
    );
    requireContract(
      !(await store.has(expected)),
      "failed put must not publish its content address",
    );
    requireContract(
      (await store.get(expected)) === null,
      "failed put must leave no partially readable blob",
    );

    requireContract(
      (await store.put(bytes)) === expected,
      "a successful retry must publish the expected address",
    );
    expect(await store.get(expected)).toEqual(bytes);
  });
}

async function requireAdded(
  store: QuestStore,
  link: Chain,
  resolveActor: ActorResolver = identityActor,
): Promise<void> {
  const result = await store.addChainLink({ link, actor: resolveActor(actor) });
  requireContract(result.outcome === "added", "valid requires link must be added");
}

async function requireEventState(
  store: QuestStore,
  questId: number,
  expectedStatus: QuestStatus,
  expectedActions: readonly Event["action"][],
): Promise<void> {
  const quest = await store.getQuest(questId);
  const events = await store.events(questId);
  requireContract(quest?.status === expectedStatus, `quest state must be ${expectedStatus}`);
  requireContract(
    events.map((event) => event.action).join(",") === expectedActions.join(","),
    `event sequence must be ${expectedActions.join(",")}`,
  );
}

function eventByAction(events: readonly Event[], action: Event["action"]): Event {
  const event = events.find((candidate) => candidate.action === action);
  requireContract(event !== undefined, `expected a ${action} event`);
  return event;
}

function offsetEquivalent(timestamp: string): string {
  return `${shiftTimestamp(timestamp, 2 * 60 * 60 * 1000).slice(0, -1)}+02:00`;
}

function shiftTimestamp(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

async function requireRejection(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  throw new Error(`Store contract: ${message}`);
}

async function requireEventRollback(
  harness: QuestStoreHarness,
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  const before = snapshotDump(await harness.store.exportAll());
  await harness.failNextEventAppend();
  await requireRejection(operation(), message);
  expect(await harness.store.exportAll()).toEqual(before);
}

async function withStore(
  factory: QuestStoreFactory,
  run: (store: QuestStore, resolveActor: ActorResolver) => Promise<void>,
): Promise<void> {
  await withHarness(factory, (harness) =>
    run(harness.store, harness.resolveActor ?? identityActor),
  );
}

async function withHarness(
  factory: QuestStoreFactory,
  run: (harness: QuestStoreHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function withBlobStore(
  factory: BlobStoreFactory,
  run: (harness: BlobStoreHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

function taskInput(title: string): NewQuest {
  return {
    repo: "contract",
    area: "store",
    kind: "task",
    title,
    description: "",
    opened_by: actor,
    assignee: null,
    status: "ready",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
  };
}

function bugInput(title: string): NewQuest {
  return {
    ...taskInput(title),
    kind: "bug",
    status: "open",
  };
}

function requires(quest: Quest, target: Quest): Chain {
  return { quest_id: quest.id, target_id: target.id, type: "requires" };
}

function sameChain(first: Chain, second: Chain): boolean {
  return (
    first.quest_id === second.quest_id &&
    first.target_id === second.target_id &&
    first.type === second.type
  );
}

function questIds(quests: readonly Quest[]): number[] {
  return quests.map(({ id }) => id).sort((first, second) => first - second);
}

function snapshotQuest(quest: Quest): Quest {
  return questSchema.parse(JSON.parse(JSON.stringify(quest)));
}

function snapshotQuests(quests: readonly Quest[]): Quest[] {
  return questSchema.array().parse(JSON.parse(JSON.stringify(quests)));
}

function snapshotEvents(events: readonly Event[]): Event[] {
  return eventSchema.array().parse(JSON.parse(JSON.stringify(events)));
}

function snapshotDump(dump: QuestDump): QuestDump {
  return questDumpSchema.parse(JSON.parse(JSON.stringify(dump)));
}

function contentHash(bytes: Uint8Array): Sha256 {
  return sha256Schema.parse(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
}

function requireContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Store contract: ${message}`);
  }
}
