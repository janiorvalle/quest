import { resolve } from "node:path";

import { type Command, Option } from "commander";
import { type JSONType, z } from "zod";

import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import { backupCountsSchema } from "../schema";
import type { BackupOperations } from "../services";
import type { Clock } from "../store";
import type { CliFormat } from "./scope";

const nonEmptyOptionSchema = z.string().trim().min(1);
const backupRunDataSchema = z.strictObject({
  snapshot: nonEmptyOptionSchema,
  path: nonEmptyOptionSchema,
  counts: backupCountsSchema,
  evidence: z.strictObject({
    copied: z.int().nonnegative(),
    count: z.int().nonnegative(),
    total_bytes: z.int().nonnegative(),
  }),
  pruned: z.array(nonEmptyOptionSchema),
});
const backupVerifyDataSchema = z.strictObject({
  snapshot: nonEmptyOptionSchema,
  verified: z.literal(true),
  full: z.boolean(),
  counts: backupCountsSchema,
  integrity_check: z.literal("ok"),
  sampled_evidence: z.array(nonEmptyOptionSchema),
});
const backupListDataSchema = z.strictObject({
  snapshots: z.array(
    z.strictObject({
      snapshot: nonEmptyOptionSchema,
      created_at: z.iso.datetime(),
      age_seconds: z.int().nonnegative(),
      size_bytes: z.int().nonnegative(),
      counts: backupCountsSchema,
    }),
  ),
});
const backupRestoreDataSchema = z.strictObject({
  snapshot: nonEmptyOptionSchema,
  pre_restore_database: nonEmptyOptionSchema.nullable(),
  pre_restore_config: nonEmptyOptionSchema.nullable(),
  evidence_restored: z.int().nonnegative(),
  verified: z.literal(true),
});
const backupPruneDataSchema = z.strictObject({
  deleted: z.array(nonEmptyOptionSchema),
  retained: z.array(nonEmptyOptionSchema),
});
const backupScheduleDataSchema = z.strictObject({
  definition_exists: z.boolean(),
  definition_path: nonEmptyOptionSchema.nullable(),
  executable: nonEmptyOptionSchema,
  executable_exists: z.boolean(),
  frequency: z.literal("daily"),
  installed: z.boolean(),
  kind: z.enum(["launchd", "systemd", "schtasks"]),
  task_name: nonEmptyOptionSchema.nullable(),
});
type BackupScheduleData = z.infer<typeof backupScheduleDataSchema>;

interface BackupScheduleOperations {
  readonly install: () => Promise<BackupScheduleData>;
  readonly status: () => Promise<BackupScheduleData>;
  readonly remove: () => Promise<BackupScheduleData>;
}

export type BackupCliRequest =
  | {
      readonly command: "backup-run";
      readonly to?: string | undefined;
    }
  | {
      readonly command: "backup-verify";
      readonly snapshot?: string | undefined;
      readonly full: boolean;
    }
  | {
      readonly command: "backup-list";
    }
  | {
      readonly command: "backup-restore";
      readonly snapshot: string;
    }
  | {
      readonly command: "backup-prune";
    }
  | {
      readonly command:
        | "backup-schedule-install"
        | "backup-schedule-status"
        | "backup-schedule-remove";
    };

export interface BackupRequestCapture {
  set(request: BackupCliRequest): void;
}

export interface ExecuteBackupCliOptions {
  readonly format: CliFormat;
  readonly output: CliOutputBoundary;
  readonly ports: {
    readonly backup?: BackupOperations | undefined;
    readonly clock: Clock;
    readonly scheduler?: BackupScheduleOperations | undefined;
  };
  readonly repository?: string | null;
  readonly request: BackupCliRequest;
  readonly workingDirectory: string;
}

export class BackupCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupCliUsageError";
  }
}

function optionalString(command: Command, name: string): string | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : nonEmptyOptionSchema.parse(value);
}

function captureSnapshot(value: string | undefined): string | undefined {
  return value === undefined ? undefined : nonEmptyOptionSchema.parse(value);
}

export function registerBackupCommands(program: Command, capture: BackupRequestCapture): void {
  const backup = program.command("backup").description("run and manage local backups");
  backup
    .command("run")
    .description("create a snapshot and apply retention")
    .addOption(new Option("--to <path>", "use a one-off local backup root"))
    .action(function (this: Command) {
      capture.set({
        command: "backup-run",
        to: optionalString(this, "to"),
      });
    });
  backup
    .command("verify [snapshot]")
    .description("verify a snapshot, or the latest")
    .addOption(new Option("--full", "rehash every evidence blob"))
    .action(function (this: Command, snapshot: string | undefined) {
      capture.set({
        command: "backup-verify",
        snapshot: captureSnapshot(snapshot),
        full: this.getOptionValue("full") === true,
      });
    });
  backup
    .command("list")
    .description("list local snapshots")
    .action(() => {
      capture.set({ command: "backup-list" });
    });
  backup
    .command("restore <snapshot>")
    .description("restore a verified local snapshot")
    .action((snapshot: string) => {
      capture.set({
        command: "backup-restore",
        snapshot: nonEmptyOptionSchema.parse(snapshot),
      });
    });
  backup
    .command("prune")
    .description("apply configured snapshot retention")
    .action(() => {
      capture.set({ command: "backup-prune" });
    });
  const schedule = backup.command("schedule").description("manage the daily backup schedule");
  schedule
    .command("install")
    .description("install or refresh the daily backup schedule")
    .action(() => {
      capture.set({ command: "backup-schedule-install" });
    });
  schedule
    .command("status")
    .description("show the daily backup schedule status")
    .action(() => {
      capture.set({ command: "backup-schedule-status" });
    });
  schedule
    .command("remove")
    .description("remove the daily backup schedule")
    .action(() => {
      capture.set({ command: "backup-schedule-remove" });
    });
}

function requireBackupOperations(backup: BackupOperations | undefined): BackupOperations {
  if (backup === undefined) {
    throw new Error("backup operations are unavailable for the configured store backend");
  }
  return backup;
}

function requireBackupScheduler(
  scheduler: BackupScheduleOperations | undefined,
): BackupScheduleOperations {
  if (scheduler === undefined) {
    throw new Error("backup scheduling is unavailable on the configured platform");
  }
  return scheduler;
}

function localOverride(path: string, workingDirectory: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) {
    throw new BackupCliUsageError(
      "backup --to is local-only; URL and cloud destinations are not supported",
    );
  }
  return resolve(workingDirectory, path);
}

async function writeJson(
  options: ExecuteBackupCliOptions,
  command: string,
  schema: z.ZodType<JSONType>,
  data: unknown,
): Promise<void> {
  const parsedData = schema.parse(data);
  const report = buildQuestReport(schema, {
    command,
    generated_at: await options.ports.clock.now(),
    filters: {},
    warnings: [],
    data: parsedData,
  });
  options.output.write(formatQuestReport(report));
}

async function executeRun(
  options: ExecuteBackupCliOptions,
  backup: BackupOperations,
  request: Extract<BackupCliRequest, { readonly command: "backup-run" }>,
): Promise<ExitCode> {
  const root =
    request.to === undefined ? undefined : localOverride(request.to, options.workingDirectory);
  const result = await backup.run(root);
  if (options.format === "json") {
    await writeJson(options, "backup run", backupRunDataSchema, result);
  } else {
    options.output.write(`Backup created ${result.snapshot} at ${result.path}\n`);
  }
  return EXIT_SUCCESS;
}

async function executeVerify(
  options: ExecuteBackupCliOptions,
  backup: BackupOperations,
  request: Extract<BackupCliRequest, { readonly command: "backup-verify" }>,
): Promise<ExitCode> {
  const result = await backup.verify(request.snapshot, { full: request.full });
  if (options.format === "json") {
    await writeJson(options, "backup verify", backupVerifyDataSchema, result);
  } else {
    options.output.write(
      `Verified ${result.snapshot}: integrity ok, ${
        result.full ? "full evidence re-hash" : `${result.sampled_evidence.length} evidence sampled`
      }\n`,
    );
  }
  return EXIT_SUCCESS;
}

async function executeList(
  options: ExecuteBackupCliOptions,
  backup: BackupOperations,
): Promise<ExitCode> {
  const snapshots = await backup.list();
  if (options.format === "json") {
    await writeJson(options, "backup list", backupListDataSchema, { snapshots });
  } else if (snapshots.length === 0) {
    options.output.write("No backup snapshots.\n");
  } else {
    options.output.write(
      `${snapshots
        .map(
          (snapshot) =>
            `${snapshot.snapshot}  ${snapshot.age_seconds}s  ${snapshot.size_bytes} bytes  ${snapshot.counts.quests} quests`,
        )
        .join("\n")}\n`,
    );
  }
  return EXIT_SUCCESS;
}

async function executeRestore(
  options: ExecuteBackupCliOptions,
  backup: BackupOperations,
  request: Extract<BackupCliRequest, { readonly command: "backup-restore" }>,
  repository: string | null | undefined,
): Promise<ExitCode> {
  const result = await backup.restore(request.snapshot, repository ?? undefined);
  if (options.format === "json") {
    await writeJson(options, "backup restore", backupRestoreDataSchema, result);
  } else {
    options.output.write(
      `Restored ${result.snapshot}; previous database: ${result.pre_restore_database ?? "none"}\n`,
    );
  }
  return EXIT_SUCCESS;
}

async function executePrune(
  options: ExecuteBackupCliOptions,
  backup: BackupOperations,
): Promise<ExitCode> {
  const result = await backup.prune();
  if (options.format === "json") {
    await writeJson(options, "backup prune", backupPruneDataSchema, result);
  } else {
    options.output.write(
      `Pruned ${result.deleted.length} snapshot(s); retained ${result.retained.length}\n`,
    );
  }
  return EXIT_SUCCESS;
}

function scheduleStatusMessage(result: BackupScheduleData): string {
  if (!result.installed) {
    return `Daily ${result.kind} backup schedule is not installed\n`;
  }
  if (!result.executable_exists) {
    return `Daily ${result.kind} backup schedule is installed but its executable is missing: ${result.executable}\n`;
  }
  return `Daily ${result.kind} backup schedule is installed for ${result.executable}\n`;
}

async function executeSchedule(
  options: ExecuteBackupCliOptions,
  operation: "install" | "status" | "remove",
): Promise<ExitCode> {
  const scheduler = requireBackupScheduler(options.ports.scheduler);
  const result = await scheduler[operation]();
  if (operation === "install" && !result.installed) {
    throw new Error(`backup schedule install did not register the daily ${result.kind} schedule`);
  }
  if (operation === "remove" && result.installed) {
    throw new Error(`backup schedule remove left the daily ${result.kind} schedule installed`);
  }
  if (options.format === "json") {
    await writeJson(options, `backup schedule ${operation}`, backupScheduleDataSchema, result);
  } else {
    switch (operation) {
      case "install":
        options.output.write(
          `Installed daily ${result.kind} backup schedule for ${result.executable}\n`,
        );
        break;
      case "status":
        options.output.write(scheduleStatusMessage(result));
        break;
      case "remove":
        options.output.write(`Removed daily ${result.kind} backup schedule\n`);
        break;
    }
  }
  return EXIT_SUCCESS;
}

export function executeBackupCli(options: ExecuteBackupCliOptions): Promise<ExitCode> {
  switch (options.request.command) {
    case "backup-run":
      return executeRun(options, requireBackupOperations(options.ports.backup), options.request);
    case "backup-verify":
      return executeVerify(options, requireBackupOperations(options.ports.backup), options.request);
    case "backup-list":
      return executeList(options, requireBackupOperations(options.ports.backup));
    case "backup-restore":
      return executeRestore(
        options,
        requireBackupOperations(options.ports.backup),
        options.request,
        options.repository,
      );
    case "backup-prune":
      return executePrune(options, requireBackupOperations(options.ports.backup));
    case "backup-schedule-install":
      return executeSchedule(options, "install");
    case "backup-schedule-status":
      return executeSchedule(options, "status");
    case "backup-schedule-remove":
      return executeSchedule(options, "remove");
  }
}

export function isBackupCliRequest(
  request: BackupCliRequest | { readonly command: string },
): request is BackupCliRequest {
  switch (request.command) {
    case "backup-run":
    case "backup-verify":
    case "backup-list":
    case "backup-restore":
    case "backup-prune":
    case "backup-schedule-install":
    case "backup-schedule-status":
    case "backup-schedule-remove":
      return true;
    default:
      return false;
  }
}
