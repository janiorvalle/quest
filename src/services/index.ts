export {
  computeQuestPlan,
  type PlanBlockerPath,
  type PlanComputedState,
  type PlanLaneCluster,
  type PlanLaneClusterKind,
  PlanModelError,
  type PlanQuest,
  planComputedStateValues,
  type QuestPlan,
  type QuestPlanInput,
} from "../domain/plan";
export {
  type BackupOperations,
  type BackupPruneResult,
  type BackupRestoreResult,
  type BackupRunResult,
  type BackupSnapshotSummary,
  type BackupVerifyOptions,
  type BackupVerifyResult,
  LocalBackupService,
  type LocalBackupServiceOptions,
  selectSnapshotsForRetention,
} from "./backup";
export {
  compileQuestBrief,
  compileQuestBriefFromDump,
  compileQuestBriefFromSnapshot,
  type QuestBrief,
} from "./brief";
export {
  addQuestChain,
  ChainCommandError,
  type ChainMutationResult,
  type ChainTree,
  type ChainTreeLine,
  type ChainTreeResult,
  removeQuestChain,
  showQuestChains,
} from "./chains";
export {
  type DoctorOperations,
  type DoctorPaths,
  type DoctorStoreInspection,
  runDoctor,
} from "./doctor";
export {
  type EventQuery,
  queryQuestEvents,
} from "./events";
export {
  createLogicalQuestExport,
  parseQuestBackupExport,
  serializeQuestBackupExport,
} from "./export";
export {
  type AddQuestResult,
  acceptLifecycleQuest,
  acceptLifecycleQuestWithDetail,
  acceptLifecycleQuestWithSnapshot,
  addLifecycleQuest,
  type DuplicateCandidate,
  type EvidenceAttachmentRequest,
  LaneConflictCommandError,
  LifecycleCommandError,
  type LifecycleServicePorts,
  type LifecycleSignoffBatchResult,
  type LifecycleTransitionOptions,
  type PullRequestMergeChecker,
  type PullRequestMergeState,
  type QuestMutationResult,
  type SessionAttribution,
  signoffLifecycleQuests,
  touchLifecycleQuest,
  transitionLifecycleQuest,
} from "./lifecycle";
export {
  type EvidenceMaterializerFactory,
  type MaterializedQuestEvidence,
  type MaterializedQuestEvidenceFile,
  materializeQuestEvidence,
} from "./materialize";
export {
  migrateRepository,
  type RepositoryMigrationBackend,
  type RepositoryMigrationOptions,
  recoverRepositoryFence,
} from "./migrate";
export {
  getNextQuest,
  type NextBacklog,
  type NextLaneConflict,
  type NextQuestOptions,
  type NextQuestResult,
  type NextSelectionPolicy,
  selectNextQuest,
  strictPriorityThenAgePolicy,
} from "./next";
export { getQuestPlan, getQuestPlanSnapshot, type QuestPlanSnapshot } from "./plan";
export { getQaQueue } from "./qa";
export {
  type ChainQuestReference,
  type ListQuestQuery,
  listQuestResults,
  QueryCommandError,
  type QuestChainPosition,
  type QuestDetail,
  questStats,
  showQuestDetail,
} from "./query";
export {
  buildQuestLogSignoffLens,
  createQuestLogRuntime,
  EMPTY_QUEST_LOG_SIGNOFF,
  EMPTY_QUEST_LOG_SNAPSHOT,
  type QuestLogDetail,
  type QuestLogItem,
  type QuestLogPlan,
  type QuestLogRuntime,
  type QuestLogRuntimeOptions,
  type QuestLogSignedHistoryEntry,
  type QuestLogSignoffGroup,
  type QuestLogSignoffLens,
  type QuestLogSnapshot,
} from "./quest-log-model";
export {
  type CreateUpgradeOperationsOptions,
  createUpgradeOperations,
  DEFAULT_UPGRADE_REPOSITORY,
  type InstalledSkillRefresher,
  replaceInstalledExecutable,
  type SkillRefreshFailure,
  type SkillRefreshReceipt,
  type SkillRefreshResult,
  UpgradeError,
  type UpgradeErrorCode,
  type UpgradeFileSystem,
  type UpgradeHttpClient,
  type UpgradeLookupResult,
  type UpgradeOperations,
  type UpgradeResult,
} from "./upgrade";
