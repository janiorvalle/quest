import { type Command, Option } from "commander";
import { stringify } from "smol-toml";
import { type JSONType, z } from "zod";

import { normalizeConvexDeployment } from "../config";
import { type CliOutputBoundary, EXIT_SUCCESS, type ExitCode, formatQuestReport } from "../output";
import { type Config, questReportSchema } from "../schema";
import {
  type ConvexListPage,
  type ConvexMember,
  clientProtocolInput,
  convexApi,
  createConvexHttpClient,
} from "../store";
import type { CliPrompter } from "./prompt";
import type { CliFormat } from "./scope";
import { hasQuestSkillInstalled, QUEST_SKILL_INSTALL_SUGGESTION } from "./skill";

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
  routing_added: z.array(nonEmptyTextSchema),
  routing_skipped: z.array(nonEmptyTextSchema),
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
      readonly routing: boolean;
    };

export interface MembersRequestCapture {
  set(request: MembersCliRequest): void;
}

export interface ConvexOnboardingOperations {
  readonly migrateReadyStatuses?: (
    deployment: string,
    adminSecret: string,
  ) => Promise<{ readonly converted: number; readonly total: number; readonly unchanged: number }>;
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
  readonly repositories: (deployment: string, authToken: string) => Promise<readonly string[]>;
}

export interface ConvexJoinConfigWriter {
  readonly writeToken: (deployment: string, token: string) => Promise<void>;
  readonly writeRouting: (
    deployment: string,
    repositories: readonly string[],
  ) => Promise<{
    readonly added: readonly string[];
    readonly conflicts: readonly {
      readonly repository: string;
      readonly configuredStore: Config["store"];
    }[];
  }>;
}

export interface ExecuteMembersCliOptions {
  readonly config: Config;
  readonly configWriter?: ConvexJoinConfigWriter | undefined;
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
    .option("--no-routing", "save the member token without adding repository routes")
    .action(function (this: Command, deployment: string) {
      capture.set({
        command: "join",
        deployment: nonEmptyTextSchema.parse(deployment),
        routing: this.getOptionValue("routing") !== false,
      });
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

function renderJoin(member: string, routingAdded: readonly string[]): string {
  const routing = routingAdded.length === 0 ? "" : ` · routing added: ${routingAdded.join(", ")}`;
  return `Connected as ${member}${routing}\n`;
}

function describeStore(store: Config["store"]): string {
  if (store.backend === "sqlite") {
    return "local SQLite";
  }
  return `Convex deployment ${store.deployment ?? store.convex_deployment ?? "with no deployment"}`;
}

function routingConflictWarning(
  deployment: string,
  repository: string,
  configuredStore: Config["store"],
): string {
  const replacement = stringify({
    repos: { [repository]: { store: { backend: "convex", deployment } } },
  }).trim();
  return `[QUEST_JOIN_ROUTE_CONFLICT] routing for ${repository} was not changed because it already points to ${describeStore(configuredStore)}, not ${deployment}; keep the current route, or replace its block in config.toml with:\n${replacement}`;
}

async function verifyJoinedMember(
  onboarding: ConvexOnboardingOperations,
  deployment: string,
  token: string,
  fallbackMember: string,
): Promise<{ readonly member: string; readonly warning?: string }> {
  try {
    return { member: (await onboarding.whoami(deployment, token)).member };
  } catch {
    return {
      member: fallbackMember,
      warning:
        "[QUEST_JOIN_VERIFICATION_FAILED] the personal token was saved, but server verification failed; retry a normal Quest command and do not run quest join again",
    };
  }
}

async function addJoinRouting(
  onboarding: ConvexOnboardingOperations,
  writer: ConvexJoinConfigWriter,
  deployment: string,
  token: string,
): Promise<{
  readonly added: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
}> {
  try {
    const repositories = await onboarding.repositories(deployment, token);
    const routing = await writer.writeRouting(deployment, repositories);
    return {
      added: routing.added,
      skipped: routing.conflicts.map((conflict) => conflict.repository),
      warnings: routing.conflicts.map((conflict) =>
        routingConflictWarning(deployment, conflict.repository, conflict.configuredStore),
      ),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      added: [],
      skipped: [],
      warnings: [
        `[QUEST_JOIN_ROUTING_FAILED] the personal token was saved and verified, but repository routing was not added: ${detail}. Add [repos.<name>.store] with backend = "convex" and deployment = "${deployment}" to config.toml before running Quest in a clone`,
      ],
    };
  }
}

async function joinSkillSuggestion(
  environment: Readonly<Record<string, string | undefined>>,
  verificationWarning: string | undefined,
): Promise<string | undefined> {
  if (verificationWarning !== undefined) {
    return undefined;
  }
  return (await hasQuestSkillInstalled(environment)) === false
    ? QUEST_SKILL_INSTALL_SUGGESTION
    : undefined;
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
    await writer.writeToken(deployment, joined.token);
  } catch {
    throw new Error(
      `[QUEST_JOIN_CONFIG_WRITE_FAILED] the invite was consumed but the personal token was not saved; fix config.toml permissions, then ask an administrator to run \`quest members rotate ${joined.member}\` and send the replacement token, or remove and reinvite ${joined.member}`,
    );
  }
  const verification = await verifyJoinedMember(
    onboarding,
    deployment,
    joined.token,
    joined.member,
  );
  const routing =
    verification.warning === undefined && request.routing
      ? await addJoinRouting(onboarding, writer, deployment, joined.token)
      : { added: [], skipped: [], warnings: [] };
  const skillSuggestion = await joinSkillSuggestion(options.environment, verification.warning);
  const data = joinDataSchema.parse({
    connected_as: verification.member,
    deployment,
    routing_added: routing.added,
    routing_skipped: routing.skipped,
  });
  const warnings = [
    ...(verification.warning === undefined ? [] : [verification.warning]),
    ...routing.warnings,
    ...(skillSuggestion === undefined ? [] : [skillSuggestion]),
  ];
  if (options.format === "json") {
    report(options, "join", data, warnings);
  } else {
    options.output.write(
      verification.warning === undefined
        ? renderJoin(data.connected_as, data.routing_added)
        : `Connected as ${data.connected_as}; token saved, but server verification failed. Retry a normal Quest command; do not run quest join again.\n`,
    );
    for (const warning of warnings) {
      if (warning === verification.warning) {
        continue;
      }
      options.output.write(`${warning}\n`);
    }
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

async function pagedConvexRepositories(
  deployment: string,
  authToken: string,
  leaseCutoff: string,
  firstPage: ConvexListPage,
): Promise<readonly string[]> {
  const client = createConvexHttpClient(deployment);
  const input = {
    ...clientProtocolInput(),
    auth_token: authToken,
    lease_cutoff: leaseCutoff,
    scope: { repo: null },
  };
  const repositories = new Set<string>();
  let page = firstPage;
  while (true) {
    if (page.section === "quests") {
      for (const quest of page.items) {
        repositories.add(quest.repo);
      }
    }
    if (page.next_cursor === null) {
      return [...repositories].sort();
    }
    const next = await client.query(convexApi.stats, { ...input, cursor: page.next_cursor });
    if ("repos" in next) {
      throw new Error(
        "[CONVEX_LIST_PROTOCOL_CHANGED] the Convex deployment changed stats protocols while discovering repositories; retry `quest join` after the deployment finishes",
      );
    }
    page = next;
  }
}

async function listConvexRepositories(
  deployment: string,
  authToken: string,
): Promise<readonly string[]> {
  const leaseCutoff = new Date().toISOString();
  const stats = await createConvexHttpClient(deployment).query(convexApi.stats, {
    ...clientProtocolInput(),
    auth_token: authToken,
    lease_cutoff: leaseCutoff,
    scope: { repo: null },
  });
  return "repos" in stats
    ? stats.repos.map((repository) => repository.repo)
    : pagedConvexRepositories(deployment, authToken, leaseCutoff, stats);
}

export function createConvexOnboardingOperations(): ConvexOnboardingOperations {
  return {
    migrateReadyStatuses: (deployment, adminSecret) =>
      createConvexHttpClient(deployment).mutation(convexApi.migrateReadyStatuses, {
        ...clientProtocolInput(),
        admin_secret: adminSecret,
      }),
    invite: (deployment, name, adminSecret) =>
      createConvexHttpClient(deployment).mutation(convexApi.membersInvite, {
        ...clientProtocolInput(),
        admin_secret: adminSecret,
        name,
      }),
    rotate: (deployment, name, adminSecret) =>
      createConvexHttpClient(deployment).mutation(convexApi.membersRotate, {
        ...clientProtocolInput(),
        admin_secret: adminSecret,
        name,
      }),
    remove: (deployment, name, adminSecret) =>
      createConvexHttpClient(deployment).mutation(convexApi.membersRemove, {
        ...clientProtocolInput(),
        admin_secret: adminSecret,
        name,
      }),
    list: (deployment, adminSecret) =>
      createConvexHttpClient(deployment).query(convexApi.membersList, {
        ...clientProtocolInput(),
        admin_secret: adminSecret,
      }),
    join: (deployment, inviteToken) =>
      createConvexHttpClient(deployment).mutation(convexApi.join, {
        ...clientProtocolInput(),
        invite_token: inviteToken,
      }),
    whoami: (deployment, authToken) =>
      createConvexHttpClient(deployment).mutation(convexApi.whoami, {
        ...clientProtocolInput(),
        auth_token: authToken,
      }),
    repositories: listConvexRepositories,
  };
}
