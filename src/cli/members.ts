import { type Command, Option } from "commander";
import { type JSONType, z } from "zod";

import { normalizeConvexDeployment } from "../config";
import { type CliOutputBoundary, EXIT_SUCCESS, type ExitCode, formatQuestReport } from "../output";
import { type Config, questReportSchema } from "../schema";
import { type ConvexMember, convexApi, createConvexHttpClient } from "../store";
import type { CliPrompter } from "./prompt";
import type { CliFormat } from "./scope";

const nonEmptyTextSchema = z.string().trim().min(1);
const memberSchema = z.strictObject({
  created_at: z.string(),
  name: nonEmptyTextSchema,
  status: z.enum(["active", "invited", "removed"]),
  updated_at: z.string(),
});
const inviteDataSchema = z.strictObject({
  member: nonEmptyTextSchema,
  token: nonEmptyTextSchema,
});
const rotateDataSchema = z.strictObject({
  member: nonEmptyTextSchema,
  old_key_expires_at: z.number().nonnegative(),
  token: nonEmptyTextSchema,
});
const removeDataSchema = z.strictObject({
  member: nonEmptyTextSchema,
  revoked_keys: z.int().nonnegative(),
});
const listDataSchema = z.strictObject({ members: z.array(memberSchema) });
const joinDataSchema = z.strictObject({
  connected_as: nonEmptyTextSchema,
  deployment: nonEmptyTextSchema,
});

export type MembersCliRequest =
  | {
      readonly command: "members-invite";
      readonly deployment?: string | undefined;
      readonly name: string;
    }
  | {
      readonly command: "members-rotate";
      readonly deployment?: string | undefined;
      readonly name: string;
    }
  | {
      readonly command: "members-remove";
      readonly deployment?: string | undefined;
      readonly name: string;
    }
  | {
      readonly command: "members-list";
      readonly deployment?: string | undefined;
    }
  | {
      readonly command: "join";
      readonly deployment: string;
    };

export interface MembersRequestCapture {
  set(request: MembersCliRequest): void;
}

export interface ConvexOnboardingOperations {
  readonly invite: (
    deployment: string,
    name: string,
    adminSecret: string,
  ) => Promise<{ readonly member: string; readonly token: string }>;
  readonly rotate: (
    deployment: string,
    name: string,
    adminSecret: string,
  ) => Promise<{
    readonly member: string;
    readonly old_key_expires_at: number;
    readonly token: string;
  }>;
  readonly remove: (
    deployment: string,
    name: string,
    adminSecret: string,
  ) => Promise<{ readonly member: string; readonly revoked_keys: number }>;
  readonly list: (deployment: string, adminSecret: string) => Promise<readonly ConvexMember[]>;
  readonly join: (
    deployment: string,
    inviteToken: string,
  ) => Promise<{ readonly member: string; readonly token: string }>;
  readonly whoami: (deployment: string, authToken: string) => Promise<{ readonly member: string }>;
}

export interface ConvexTokenWriter {
  readonly write: (deployment: string, token: string) => Promise<void>;
}

export interface ExecuteMembersCliOptions {
  readonly config: Config;
  readonly configWriter?: ConvexTokenWriter | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly format: CliFormat;
  readonly onboarding?: ConvexOnboardingOperations | undefined;
  readonly output: CliOutputBoundary;
  readonly prompter: CliPrompter;
  readonly request: MembersCliRequest;
}

export class MembersCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembersCliUsageError";
  }
}

export function registerMembersCommands(program: Command, capture: MembersRequestCapture): void {
  const members = program.command("members").description("manage Convex member onboarding");
  members
    .command("invite <name>")
    .description("create a one-time invite token")
    .addOption(new Option("--deployment <url>", "use a specific Convex deployment"))
    .action(function (this: Command, name: string) {
      capture.set({
        command: "members-invite",
        ...(optionalDeployment(this) === undefined ? {} : { deployment: optionalDeployment(this) }),
        name: nonEmptyTextSchema.parse(name),
      });
    });
  members
    .command("rotate <name>")
    .description("replace an active member token")
    .addOption(new Option("--deployment <url>", "use a specific Convex deployment"))
    .action(function (this: Command, name: string) {
      capture.set({
        command: "members-rotate",
        ...(optionalDeployment(this) === undefined ? {} : { deployment: optionalDeployment(this) }),
        name: nonEmptyTextSchema.parse(name),
      });
    });
  members
    .command("remove <name>")
    .description("revoke a member's keys")
    .addOption(new Option("--deployment <url>", "use a specific Convex deployment"))
    .action(function (this: Command, name: string) {
      capture.set({
        command: "members-remove",
        ...(optionalDeployment(this) === undefined ? {} : { deployment: optionalDeployment(this) }),
        name: nonEmptyTextSchema.parse(name),
      });
    });
  members
    .command("list")
    .description("list members without exposing keys")
    .addOption(new Option("--deployment <url>", "use a specific Convex deployment"))
    .action(function (this: Command) {
      capture.set({
        command: "members-list",
        ...(optionalDeployment(this) === undefined ? {} : { deployment: optionalDeployment(this) }),
      });
    });
  program
    .command("join <deployment-url>")
    .description("join a Convex deployment with a one-time invite")
    .action((deployment: string) => {
      capture.set({ command: "join", deployment: nonEmptyTextSchema.parse(deployment) });
    });
}

function optionalDeployment(command: Command): string | undefined {
  const value = command.getOptionValue("deployment");
  return value === undefined ? undefined : nonEmptyTextSchema.parse(value);
}

function requireOnboardingOperations(
  operations: ConvexOnboardingOperations | undefined,
): ConvexOnboardingOperations {
  if (operations === undefined) {
    throw new Error(
      "[QUEST_ONBOARDING_UNAVAILABLE] Convex onboarding is unavailable in this build; install the Convex backend and retry",
    );
  }
  return operations;
}

function resolveDeployment(config: Config, explicit: string | undefined): string {
  const deployment = explicit ?? config.store.convex_deployment ?? config.store.deployment;
  if (deployment === undefined || deployment.trim() === "") {
    throw new MembersCliUsageError(
      '[QUEST_CONVEX_DEPLOYMENT_REQUIRED] set [store] backend = "convex" and convex_deployment in config.toml, or retry with --deployment <url>',
    );
  }
  return normalizeConvexDeployment(deployment);
}

async function promptSecret(prompter: CliPrompter, question: string): Promise<string> {
  const answer =
    prompter.askSecret === undefined
      ? await prompter.ask(question)
      : await prompter.askSecret(question);
  const normalized = answer.trim();
  if (normalized === "") {
    throw new MembersCliUsageError(
      "[QUEST_SECRET_REQUIRED] enter a non-empty secret and retry; no Convex request was sent",
    );
  }
  return normalized;
}

async function resolveAdminSecret(options: ExecuteMembersCliOptions): Promise<string> {
  const configured = options.environment["QUEST_ADMIN_SECRET"];
  return configured === undefined || configured.trim() === ""
    ? promptSecret(options.prompter, "Admin secret: ")
    : configured.trim();
}

function report(
  options: ExecuteMembersCliOptions,
  command: string,
  data: JSONType,
  warnings: readonly string[] = [],
): void {
  options.output.write(
    formatQuestReport(
      questReportSchema.parse({
        schema: "quest.report/v1",
        command,
        generated_at: new Date().toISOString(),
        filters: {},
        warnings: [...warnings],
        data,
      }),
    ),
  );
}

function renderInvite(member: string, token: string): string {
  return `Invited ${member}. One-time token: ${token}\n`;
}

function renderRotate(member: string, token: string, expiresAt: number): string {
  return `Rotated ${member}. New token: ${token} (old token expires at ${new Date(expiresAt).toISOString()})\n`;
}

function renderRemove(member: string, revokedKeys: number): string {
  return `Removed ${member}; revoked ${revokedKeys} key${revokedKeys === 1 ? "" : "s"}\n`;
}

function renderMembers(members: readonly ConvexMember[]): string {
  if (members.length === 0) {
    return "No members\n";
  }
  return `${members.map((member) => `${member.name}\t${member.status}\t${member.updated_at}`).join("\n")}\n`;
}

function renderJoin(member: string): string {
  return `Connected as ${member}\n`;
}

async function executeInvite(
  options: ExecuteMembersCliOptions,
  request: Extract<MembersCliRequest, { readonly command: "members-invite" }>,
): Promise<ExitCode> {
  const deployment = resolveDeployment(options.config, request.deployment);
  const result = await requireOnboardingOperations(options.onboarding).invite(
    deployment,
    request.name,
    await resolveAdminSecret(options),
  );
  const data = inviteDataSchema.parse(result);
  if (options.format === "json") {
    report(options, "members invite", data);
  } else {
    options.output.write(renderInvite(data.member, data.token));
  }
  return EXIT_SUCCESS;
}

async function executeRotate(
  options: ExecuteMembersCliOptions,
  request: Extract<MembersCliRequest, { readonly command: "members-rotate" }>,
): Promise<ExitCode> {
  const deployment = resolveDeployment(options.config, request.deployment);
  const result = await requireOnboardingOperations(options.onboarding).rotate(
    deployment,
    request.name,
    await resolveAdminSecret(options),
  );
  const data = rotateDataSchema.parse(result);
  if (options.format === "json") {
    report(options, "members rotate", data);
  } else {
    options.output.write(renderRotate(data.member, data.token, data.old_key_expires_at));
  }
  return EXIT_SUCCESS;
}

async function executeRemove(
  options: ExecuteMembersCliOptions,
  request: Extract<MembersCliRequest, { readonly command: "members-remove" }>,
): Promise<ExitCode> {
  const deployment = resolveDeployment(options.config, request.deployment);
  const result = await requireOnboardingOperations(options.onboarding).remove(
    deployment,
    request.name,
    await resolveAdminSecret(options),
  );
  const data = removeDataSchema.parse(result);
  if (options.format === "json") {
    report(options, "members remove", data);
  } else {
    options.output.write(renderRemove(data.member, data.revoked_keys));
  }
  return EXIT_SUCCESS;
}

async function executeList(
  options: ExecuteMembersCliOptions,
  request: Extract<MembersCliRequest, { readonly command: "members-list" }>,
): Promise<ExitCode> {
  const deployment = resolveDeployment(options.config, request.deployment);
  const members = await requireOnboardingOperations(options.onboarding).list(
    deployment,
    await resolveAdminSecret(options),
  );
  const data = listDataSchema.parse({ members });
  if (options.format === "json") {
    report(options, "members list", data);
  } else {
    options.output.write(renderMembers(data.members));
  }
  return EXIT_SUCCESS;
}

async function executeJoin(
  options: ExecuteMembersCliOptions,
  request: Extract<MembersCliRequest, { readonly command: "join" }>,
): Promise<ExitCode> {
  const writer = options.configWriter;
  if (writer === undefined) {
    throw new Error(
      "[QUEST_JOIN_CONFIG_WRITER_UNAVAILABLE] this build cannot save the personal token; configure a token writer and retry (the invite was not consumed)",
    );
  }
  const deployment = normalizeConvexDeployment(request.deployment);
  const inviteToken = await promptSecret(options.prompter, "Invite token: ");
  const onboarding = requireOnboardingOperations(options.onboarding);
  const joined = await onboarding.join(deployment, inviteToken);
  try {
    await writer.write(deployment, joined.token);
  } catch {
    throw new Error(
      `[QUEST_JOIN_CONFIG_WRITE_FAILED] the invite was consumed but the personal token was not saved; fix config.toml permissions, then ask an administrator to run \`quest members rotate ${joined.member}\` and send the replacement token, or remove and reinvite ${joined.member}`,
    );
  }
  let verificationWarning: string | undefined;
  let connectedAs = joined.member;
  try {
    connectedAs = (await onboarding.whoami(deployment, joined.token)).member;
  } catch {
    verificationWarning =
      "[QUEST_JOIN_VERIFICATION_FAILED] the personal token was saved, but server verification failed; retry a normal Quest command and do not run quest join again";
  }
  const data = joinDataSchema.parse({ connected_as: connectedAs, deployment });
  if (options.format === "json") {
    report(options, "join", data, verificationWarning === undefined ? [] : [verificationWarning]);
  } else {
    options.output.write(
      verificationWarning === undefined
        ? renderJoin(data.connected_as)
        : `Connected as ${data.connected_as}; token saved, but server verification failed. Retry a normal Quest command; do not run quest join again.\n`,
    );
  }
  return EXIT_SUCCESS;
}

export async function executeMembersCli(options: ExecuteMembersCliOptions): Promise<ExitCode> {
  switch (options.request.command) {
    case "members-invite":
      return executeInvite(options, options.request);
    case "members-rotate":
      return executeRotate(options, options.request);
    case "members-remove":
      return executeRemove(options, options.request);
    case "members-list":
      return executeList(options, options.request);
    case "join":
      return executeJoin(options, options.request);
  }
}

export function isMembersCliRequest(
  request: MembersCliRequest | { readonly command: string },
): request is MembersCliRequest {
  return (
    request.command === "members-invite" ||
    request.command === "members-rotate" ||
    request.command === "members-remove" ||
    request.command === "members-list" ||
    request.command === "join"
  );
}

export function createConvexOnboardingOperations(): ConvexOnboardingOperations {
  return {
    invite: (deployment, name, adminSecret) =>
      createConvexHttpClient(deployment).mutation(convexApi.membersInvite, {
        admin_secret: adminSecret,
        name,
      }),
    rotate: (deployment, name, adminSecret) =>
      createConvexHttpClient(deployment).mutation(convexApi.membersRotate, {
        admin_secret: adminSecret,
        name,
      }),
    remove: (deployment, name, adminSecret) =>
      createConvexHttpClient(deployment).mutation(convexApi.membersRemove, {
        admin_secret: adminSecret,
        name,
      }),
    list: (deployment, adminSecret) =>
      createConvexHttpClient(deployment).query(convexApi.membersList, {
        admin_secret: adminSecret,
      }),
    join: (deployment, inviteToken) =>
      createConvexHttpClient(deployment).mutation(convexApi.join, {
        invite_token: inviteToken,
      }),
    whoami: (deployment, authToken) =>
      createConvexHttpClient(deployment).mutation(convexApi.whoami, {
        auth_token: authToken,
      }),
  };
}
