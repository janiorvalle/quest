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
  acceptLifecycleQuestWithSnapshot,
  addLifecycleQuest,
  type DuplicateCandidate,
  type EvidenceAttachmentRequest,
  LifecycleCommandError,
  type LifecycleServicePorts,
  type LifecycleTransitionOptions,
  type PullRequestMergeChecker,
  type PullRequestMergeState,
  type QuestMutationResult,
  type SessionAttribution,
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
  type NextQuestResult,
  type NextSelectionPolicy,
  selectNextQuest,
  strictPriorityThenAgePolicy,
} from "./next";
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
  createQuestLogRuntime,
  EMPTY_QUEST_LOG_SNAPSHOT,
  type QuestLogDetail,
  type QuestLogItem,
  type QuestLogRuntime,
  type QuestLogRuntimeOptions,
  type QuestLogSnapshot,
} from "./quest-log-model";
export {
  type CreateUpgradeOperationsOptions,
  createUpgradeOperations,
  DEFAULT_UPGRADE_REPOSITORY,
  replaceInstalledExecutable,
  UpgradeError,
  type UpgradeErrorCode,
  type UpgradeFileSystem,
  type UpgradeHttpClient,
  type UpgradeLookupResult,
  type UpgradeOperations,
  type UpgradeResult,
} from "./upgrade";
