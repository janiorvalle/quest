import { type Command, Option } from "commander";
import { z } from "zod";

import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import { type MigrationResult, migrationBackendSchema, migrationResultSchema } from "../schema";
import type { Clock } from "../store";
import type { CliFormat } from "./scope";

const nonEmptyTextSchema = z.string().trim().min(1);

export type RepositoryMigrationRequest = {
  readonly repository: string;
  readonly target: z.infer<typeof migrationBackendSchema>;
  readonly deployment?: string;
};

export type MigrateCliRequest =
  | {
      readonly command: "migrate";
    }
  | {
      readonly command: "migrate";
      readonly target: z.infer<typeof migrationBackendSchema>;
      readonly repository: string;
      readonly deployment?: string;
    };

export interface MigrateRequestCapture {
  set(request: MigrateCliRequest): void;
}

export interface RepositoryMigrationOperations {
  migrate(request: RepositoryMigrationRequest): Promise<MigrationResult>;
}

export interface ExecuteRepositoryMigrationCliOptions {
  readonly clock: Clock;
  readonly format: CliFormat;
  readonly migration: RepositoryMigrationOperations;
  readonly output: CliOutputBoundary;
  readonly request: Extract<MigrateCliRequest, { readonly repository: string }>;
}

export class MigrateCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrateCliUsageError";
  }
}

function optionalString(command: Command, name: string): string | undefined {
  const value = command.getOptionValue(name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = nonEmptyTextSchema.safeParse(value);
  if (!parsed.success) {
    throw new MigrateCliUsageError(`--${name} must not be empty; pass a value and retry`);
  }
  return parsed.data;
}

function optionalTarget(command: Command) {
  const value = command.getOptionValue("to");
  if (value === undefined) {
    return undefined;
  }
  const parsed = migrationBackendSchema.safeParse(value);
  if (!parsed.success) {
    throw new MigrateCliUsageError("--to must be sqlite or convex; choose one and retry");
  }
  return parsed.data;
}

function requiredRepository(value: string): string {
  const parsed = nonEmptyTextSchema.safeParse(value);
  if (!parsed.success) {
    throw new MigrateCliUsageError("<repo> must not be empty; pass a repository name and retry");
  }
  return parsed.data;
}

function captureSchemaMigration(
  capture: MigrateRequestCapture,
  repository: string | undefined,
  deployment: string | undefined,
): void {
  if (repository !== undefined || deployment !== undefined) {
    throw new MigrateCliUsageError(
      "schema migration is `quest migrate`; repository replay is `quest migrate --to <sqlite|convex> <repo>`",
    );
  }
  capture.set({ command: "migrate" });
}

function captureRepositoryMigration(
  capture: MigrateRequestCapture,
  repository: string | undefined,
  target: z.infer<typeof migrationBackendSchema>,
  deployment: string | undefined,
): void {
  if (repository === undefined) {
    throw new MigrateCliUsageError(
      `repository replay to ${target} requires <repo>; example: quest migrate --to ${target} web-app`,
    );
  }
  if (target !== "convex" && deployment !== undefined) {
    throw new MigrateCliUsageError("--deployment is only valid with `--to convex`");
  }
  capture.set({
    command: "migrate",
    repository,
    target,
    ...(deployment === undefined ? {} : { deployment }),
  });
}

export function registerMigrateCommand(program: Command, capture: MigrateRequestCapture): void {
  program
    .command("migrate [repository]")
    .description("migrate the local schema or replay one repository to another backend")
    .addOption(
      new Option("--to <backend>", "replay a repository to this backend").choices([
        "sqlite",
        "convex",
      ]),
    )
    .addOption(new Option("--deployment <url>", "Convex deployment for --to convex"))
    .action(function (this: Command, repository: string | undefined) {
      const target = optionalTarget(this);
      const normalizedRepository =
        repository === undefined ? undefined : requiredRepository(repository);
      const deployment = optionalString(this, "deployment");

      if (target === undefined) {
        captureSchemaMigration(capture, normalizedRepository, deployment);
        return;
      }
      captureRepositoryMigration(capture, normalizedRepository, target, deployment);
    });
}

function renderMigration(result: MigrationResult): string {
  const deployment = result.deployment === null ? "local SQLite" : result.deployment;
  const action = result.recovered ? "Recovered" : "Migrated";
  return [
    `${action} ${result.repository}: ${result.source_backend} -> ${result.target_backend} (${deployment})`,
    `Verified ${result.counts.quests} quests, ${result.counts.evidence} evidence, ${result.counts.chains} chains, and ${result.counts.events} events`,
    `Backups: source ${result.backups.source}; destination ${result.backups.destination ?? "none"}`,
  ].join("\n");
}

export async function executeRepositoryMigrationCli(
  options: ExecuteRepositoryMigrationCliOptions,
): Promise<ExitCode> {
  const result = migrationResultSchema.parse(
    await options.migration.migrate({
      repository: options.request.repository,
      target: options.request.target,
      ...(options.request.deployment === undefined
        ? {}
        : { deployment: options.request.deployment }),
    }),
  );
  if (options.format === "json") {
    const report = buildQuestReport(migrationResultSchema, {
      command: "migrate",
      generated_at: await options.clock.now(),
      filters: { repo: result.repository },
      warnings: [],
      data: result,
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(`${renderMigration(result)}\n`);
  }
  return EXIT_SUCCESS;
}
