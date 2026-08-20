import type { Command } from "commander";

import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import { type DoctorScope, doctorDataSchema, type StoreCompatibilityResult } from "../schema";
import { type DoctorOperations, runDoctor } from "../services";
import type { Clock } from "../store";
import type { CliFormat } from "./scope";

export type DoctorCliRequest = {
  readonly command: "doctor";
};

export interface DoctorRequestCapture {
  set(request: DoctorCliRequest): void;
}

export interface ExecuteDoctorCliOptions {
  readonly clock: Clock;
  readonly compatibility?: StoreCompatibilityResult | undefined;
  readonly compatibilityError?: unknown;
  readonly doctor?: DoctorOperations | undefined;
  readonly format: CliFormat;
  readonly olderStoreRemedy?: string | undefined;
  readonly output: CliOutputBoundary;
  readonly scope?: DoctorScope | undefined;
  readonly warnings?: readonly string[] | undefined;
}

export function registerDoctorCommand(program: Command, capture: DoctorRequestCapture): void {
  program
    .command("doctor")
    .description("run a read-only health check")
    .action(() => capture.set({ command: "doctor" }));
}

function statusMarker(status: "fail" | "pass" | "warn"): string {
  switch (status) {
    case "pass":
      return "[ok]";
    case "warn":
      return "[warn]";
    case "fail":
      return "[FAIL]";
  }
}

function renderDoctor(data: ReturnType<typeof doctorDataSchema.parse>): string {
  const lines = [`quest doctor: ${data.healthy ? "HEALTHY" : "NEEDS ATTENTION"}`];
  if (data.scope !== null) {
    lines.push(`scope: repo=${data.scope.repo ?? "<none>"}; store=${data.scope.backend}`);
  }
  for (const check of data.checks) {
    const remedy = check.remedy === null ? "" : `; remedy: ${check.remedy}`;
    lines.push(`${statusMarker(check.status)} ${check.check}: ${check.summary}${remedy}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function executeDoctorCli(options: ExecuteDoctorCliOptions): Promise<ExitCode> {
  if (options.doctor === undefined) {
    throw new Error("doctor diagnostics are unavailable for the configured store backend");
  }
  const now = await options.clock.now();
  const data = await runDoctor({
    compatibility: options.compatibility,
    compatibilityError: options.compatibilityError,
    olderStoreRemedy: options.olderStoreRemedy,
    operations: options.doctor,
    now,
  });
  const scopedData = doctorDataSchema.parse({
    ...data,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  if (options.format === "json") {
    const report = buildQuestReport(doctorDataSchema, {
      command: "doctor",
      data: scopedData,
      filters: {},
      generated_at: now,
      warnings: [...(options.warnings ?? [])],
    });
    options.output.write(formatQuestReport(report));
  } else {
    for (const warning of options.warnings ?? []) {
      options.output.writeWarning(warning);
    }
    options.output.write(renderDoctor(scopedData));
  }
  return scopedData.healthy ? EXIT_SUCCESS : EXIT_DOMAIN_ERROR;
}

export function isDoctorCliRequest(
  request: DoctorCliRequest | { readonly command: string },
): request is DoctorCliRequest {
  return request.command === "doctor";
}
