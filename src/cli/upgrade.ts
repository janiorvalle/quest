import { type Command, Option } from "commander";
import { z } from "zod";

import {
  buildQuestReport,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import type { UpgradeOperations, UpgradeResult } from "../services";
import type { Clock } from "../store";
import type { CliFormat } from "./scope";

const upgradeDataSchema = z.strictObject({
  artifact: z.string().trim().min(1),
  artifact_url: z.url(),
  checksum: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  current_version: z.string().trim().min(1),
  installed: z.boolean(),
  latest_version: z.string().trim().min(1),
  release_url: z.url(),
  repository: z.string().trim().min(1),
  skill_refresh_failures: z.array(
    z.strictObject({
      agent: z.string().trim().min(1),
      message: z.string().trim().min(1),
      remedy: z.literal("quest skill install --force"),
    }),
  ),
  skill_refreshes: z.array(
    z.strictObject({
      agent: z.string().trim().min(1),
      previous_version: z.string().trim().min(1),
    }),
  ),
  target: z.string().trim().min(1),
  update_available: z.boolean(),
});

export interface UpgradeCliRequest {
  readonly check: boolean;
  readonly command: "upgrade";
}

export interface UpgradeRequestCapture {
  set(request: UpgradeCliRequest): void;
}

export interface ExecuteUpgradeCliOptions {
  readonly applicationVersion: string;
  readonly clock: Clock;
  readonly format: CliFormat;
  readonly operations: UpgradeOperations;
  readonly output: CliOutputBoundary;
  readonly request: UpgradeCliRequest;
}

export function registerUpgradeCommand(program: Command, capture: UpgradeRequestCapture): void {
  program
    .command("upgrade")
    .description("check for and install the latest release")
    .addOption(new Option("--check", "check the latest release without installing"))
    .action(function (this: Command) {
      capture.set({
        check: this.getOptionValue("check") === true,
        command: "upgrade",
      });
    });
}

function renderUpgrade(result: UpgradeResult, check: boolean): string {
  if (!result.update_available) {
    return `quest upgrade: ${result.current_version} is already the latest release\n`;
  }
  if (check) {
    return `quest upgrade: ${result.latest_version} is available (current ${result.current_version}); run quest upgrade to install\n`;
  }
  const refreshes = result.skill_refreshes.map(
    (refresh) => `refreshed skill for ${refresh.agent} (was ${refresh.previous_version})\n`,
  );
  const failures = result.skill_refresh_failures.map(
    (failure) =>
      `warning: could not refresh skill for ${failure.agent}: ${failure.message}; run \`${failure.remedy}\`\n`,
  );
  return `Upgraded quest ${result.current_version} -> ${result.latest_version}\nchecksum: ${result.checksum}\n${refreshes.join("")}${failures.join("")}`;
}

export async function executeUpgradeCli(options: ExecuteUpgradeCliOptions): Promise<ExitCode> {
  const result = options.request.check
    ? {
        ...(await options.operations.check(options.applicationVersion)),
        checksum: null,
        installed: false,
        skill_refresh_failures: [],
        skill_refreshes: [],
      }
    : await options.operations.install(options.applicationVersion);
  const data = upgradeDataSchema.parse(result);
  if (options.format === "json") {
    const report = buildQuestReport(upgradeDataSchema, {
      command: "upgrade",
      data,
      filters: {},
      generated_at: await options.clock.now(),
      warnings: data.skill_refresh_failures.map(
        (failure) =>
          `could not refresh skill for ${failure.agent}: ${failure.message}; run ${failure.remedy}`,
      ),
    });
    options.output.write(formatQuestReport(report));
  } else {
    options.output.write(renderUpgrade(data, options.request.check));
  }
  return EXIT_SUCCESS;
}

export function isUpgradeCliRequest(
  request: UpgradeCliRequest | { readonly command: string },
): request is UpgradeCliRequest {
  return request.command === "upgrade";
}
