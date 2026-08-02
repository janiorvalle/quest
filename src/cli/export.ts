import { resolve } from "node:path";

import { type Command, Option } from "commander";
import { z } from "zod";

import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import { createLogicalQuestExport, serializeQuestBackupExport } from "../services";
import type { Clock, QuestStore } from "../store";
import type { CliFormat } from "./scope";

const nonEmptyOptionSchema = z.string().trim().min(1);
const exportResultSchema = z.strictObject({
  export_format: z.literal("json"),
  path: nonEmptyOptionSchema,
});

export interface ExportCliRequest {
  readonly command: "export";
  readonly out?: string | undefined;
}

export interface ExportRequestCapture {
  set(request: ExportCliRequest): void;
}

export interface ExecuteExportCliOptions {
  readonly format: CliFormat;
  readonly output: CliOutputBoundary;
  readonly ports: {
    readonly clock: Clock;
    readonly questStore: QuestStore;
  };
  readonly request: ExportCliRequest;
  readonly workingDirectory: string;
}

export class ExportCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportCliUsageError";
  }
}

function booleanOption(command: Command, name: string): boolean {
  return z.boolean().parse(command.getOptionValue(name) ?? false);
}

function optionalString(command: Command, name: string): string | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : nonEmptyOptionSchema.parse(value);
}

export function registerExportCommand(program: Command, capture: ExportRequestCapture): void {
  program
    .command("export")
    .description("export the complete logical JSON backup")
    .addOption(new Option("--json", "write the complete logical backup"))
    .option("--out <file>", "write to file")
    .action(function (this: Command) {
      if (!booleanOption(this, "json")) {
        throw new ExportCliUsageError("--json is required");
      }
      capture.set({
        command: "export",
        out: optionalString(this, "out"),
      });
    });
}

async function writeExportResult(options: ExecuteExportCliOptions, path: string): Promise<void> {
  if (options.format === "json") {
    const report = buildQuestReport(exportResultSchema, {
      command: "export",
      generated_at: await options.ports.clock.now(),
      filters: {},
      warnings: [],
      data: {
        export_format: "json",
        path,
      },
    });
    options.output.write(formatQuestReport(report));
    return;
  }
  options.output.write(`Exported JSON to ${path}\n`);
}

export async function executeExportCli(options: ExecuteExportCliOptions): Promise<ExitCode> {
  const serialized = serializeQuestBackupExport(
    await createLogicalQuestExport(options.ports.questStore),
  );
  if (options.request.out === undefined) {
    options.output.write(serialized);
    return EXIT_SUCCESS;
  }

  const path = resolve(options.workingDirectory, options.request.out);
  await Bun.write(path, serialized);
  await writeExportResult(options, path);
  return EXIT_SUCCESS;
}

export function isExportCliRequest(
  request: ExportCliRequest | { readonly command: string },
): request is ExportCliRequest {
  return request.command === "export";
}
