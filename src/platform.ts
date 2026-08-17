import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

const APPLICATION_DIRECTORY = "quest";
const POSIX_INSTALL_DIRECTORY = ".local/bin";
const BACKUP_SCHEDULE_FREQUENCY = "daily";
const BACKUP_SCHEDULE_TIME = "03:00";
const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 5_000;
const WINDOWS_TASK_STATUS_PROBE = String.raw`
$ErrorActionPreference = "Stop"
try {
  $scheduler = New-Object -ComObject "Schedule.Service"
  $scheduler.Connect()
  $task = $scheduler.GetFolder("\").GetTask($taskName)
  if (-not $task.Enabled) {
    exit 4
  }
  exit 0
} catch {
  if ($_.Exception.HResult -eq -2147024894) {
    exit 3
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function windowsTaskStatusProbe(name: string): string {
  const encodedName = Buffer.from(name, "utf8").toString("base64");
  return `$taskName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedName}"))\n${WINDOWS_TASK_STATUS_PROBE}`;
}
export type SupportedPlatform = "darwin" | "linux" | "win32";
export type SchedulerKind = "launchd" | "systemd" | "schtasks";
export type SchedulerOperation = "install" | "status" | "remove";

export interface PlatformCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeout_ms?: number;
  readonly waitForExit?: boolean;
}

export interface PlatformCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type PlatformCommandResultRunner = (
  command: PlatformCommand,
) => Promise<PlatformCommandResult>;
export type PlatformCommandRunner = (command: PlatformCommand) => Promise<void>;

export type ExecutableReplacementOutcome = "replaced" | "scheduled";

export interface ExecutableReplacementOptions {
  readonly destination: string;
  readonly previousExecutable?: string | undefined;
  readonly stagedExecutable: string;
  readonly temporaryDirectory: string;
}

export type ExecutableReplacer = (
  options: ExecutableReplacementOptions,
) => Promise<ExecutableReplacementOutcome>;

export interface EvidenceOpener {
  readonly openEvidence: (filePath: string) => Promise<void>;
  readonly openUrl: (url: string) => Promise<void>;
}

export interface ProcessHolder {
  readonly command: string;
  readonly paths: readonly string[];
  readonly pid: number;
}

export interface ProcessHoldingResult {
  readonly available: boolean;
  readonly detail?: string | undefined;
  readonly holders: readonly ProcessHolder[];
}

export type ProcessHolderProbe = (paths: readonly string[]) => Promise<ProcessHoldingResult>;

export interface PlatformDirectories {
  readonly config: string;
  readonly state: string;
  readonly evidence: string;
  readonly backup: string;
  readonly install: string;
  readonly executable: string;
}

export interface BackupScheduler {
  readonly kind: SchedulerKind;
  readonly install: () => Promise<BackupScheduleStatus>;
  readonly status: () => Promise<BackupScheduleStatus>;
  readonly remove: () => Promise<BackupScheduleStatus>;
}

export interface BackupScheduleStatus {
  readonly definition_exists: boolean;
  readonly definition_path: string | null;
  readonly executable: string;
  readonly executable_exists: boolean;
  readonly frequency: typeof BACKUP_SCHEDULE_FREQUENCY;
  readonly installed: boolean;
  readonly kind: SchedulerKind;
  readonly task_name: string | null;
}

export interface PlatformModule {
  readonly name: SupportedPlatform;
  readonly directories: PlatformDirectories;
  readonly inspectProcessesHoldingPaths?: ProcessHolderProbe;
  readonly scheduler: BackupScheduler;
  readonly evidenceOpenCommand?: (filePath: string) => PlatformCommand;
  readonly openEvidence?: (filePath: string) => Promise<void>;
  readonly urlOpenCommand: (url: string) => PlatformCommand;
  readonly openUrl: (url: string) => Promise<void>;
  readonly replaceExecutable?: ExecutableReplacer;
  readonly isInstallDirectoryOnPath: (searchPath?: string) => boolean;
  readonly addInstallDirectoryToPath: (searchPath?: string) => string;
}

export interface PlatformModuleOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly schedulerExecutable?: string;
  readonly schedulerName?: string;
  readonly userId?: string;
  readonly workingDirectory?: string;
  readonly runCommand?: PlatformCommandRunner;
  readonly runCommandAndWait?: PlatformCommandResultRunner;
}

export async function validateWorkingDirectory(workingDirectory: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(workingDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`working directory is not accessible: ${workingDirectory} (${detail})`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`working directory is not a directory: ${workingDirectory}`);
  }
}

export class UnsupportedPlatformError extends Error {
  readonly platform: string;

  constructor(platform: string) {
    super(`unsupported platform: ${platform}`);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
  }
}

export class SchedulerNotImplementedError extends Error {
  readonly scheduler: SchedulerKind;
  readonly operation: SchedulerOperation;

  constructor(scheduler: SchedulerKind, operation: SchedulerOperation) {
    super(`${scheduler} scheduler ${operation} is not implemented`);
    this.name = "SchedulerNotImplementedError";
    this.scheduler = scheduler;
    this.operation = operation;
  }
}

function supportedPlatform(platform: NodeJS.Platform): SupportedPlatform {
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return platform;
    default:
      throw new UnsupportedPlatformError(platform);
  }
}

function nonEmptyEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === "" ? undefined : value;
}

function caseInsensitiveEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const expectedName = name.toLowerCase();
  for (const [environmentName, value] of Object.entries(environment)) {
    if (environmentName.toLowerCase() === expectedName) {
      const trimmed = value?.trim();
      return trimmed === "" ? undefined : trimmed;
    }
  }
  return undefined;
}

function absoluteEnvironmentDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  isAbsolute: (path: string) => boolean,
): string | undefined {
  const value = nonEmptyEnvironmentValue(environment, name);
  return value !== undefined && isAbsolute(value) ? value : undefined;
}

function absoluteCaseInsensitiveEnvironmentDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  isAbsolute: (path: string) => boolean,
): string | undefined {
  const value = caseInsensitiveEnvironmentValue(environment, name);
  return value !== undefined && isAbsolute(value) ? value : undefined;
}

function windowsSystemPath(
  environment: Readonly<Record<string, string | undefined>>,
  ...segments: string[]
): string {
  const configuredSystemRoot = caseInsensitiveEnvironmentValue(environment, "SystemRoot");
  const systemRoot =
    configuredSystemRoot !== undefined && win32.isAbsolute(configuredSystemRoot)
      ? configuredSystemRoot
      : "C:\\Windows";
  return win32.join(systemRoot, "System32", ...segments);
}

function platformDirectories(
  platform: SupportedPlatform,
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): PlatformDirectories {
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(homeDirectory)) {
    throw new Error(`home directory must be absolute: ${homeDirectory}`);
  }

  const backup = paths.join(homeDirectory, "Backups", APPLICATION_DIRECTORY);

  switch (platform) {
    case "darwin": {
      const config = paths.join(homeDirectory, ".config", APPLICATION_DIRECTORY);
      const state = paths.join(homeDirectory, ".local", "state", APPLICATION_DIRECTORY);
      const install = paths.join(homeDirectory, POSIX_INSTALL_DIRECTORY);
      return {
        config,
        state,
        evidence: paths.join(state, "evidence"),
        backup,
        install,
        executable: paths.join(install, APPLICATION_DIRECTORY),
      };
    }
    case "linux": {
      const configRoot =
        absoluteEnvironmentDirectory(environment, "XDG_CONFIG_HOME", paths.isAbsolute) ??
        paths.join(homeDirectory, ".config");
      const stateRoot =
        absoluteEnvironmentDirectory(environment, "XDG_STATE_HOME", paths.isAbsolute) ??
        paths.join(homeDirectory, ".local", "state");
      const config = paths.join(configRoot, APPLICATION_DIRECTORY);
      const state = paths.join(stateRoot, APPLICATION_DIRECTORY);
      const install = paths.join(homeDirectory, POSIX_INSTALL_DIRECTORY);
      return {
        config,
        state,
        evidence: paths.join(state, "evidence"),
        backup,
        install,
        executable: paths.join(install, APPLICATION_DIRECTORY),
      };
    }
    case "win32": {
      const appData =
        absoluteCaseInsensitiveEnvironmentDirectory(environment, "APPDATA", paths.isAbsolute) ??
        paths.join(homeDirectory, "AppData", "Roaming");
      const localAppData =
        absoluteCaseInsensitiveEnvironmentDirectory(
          environment,
          "LOCALAPPDATA",
          paths.isAbsolute,
        ) ?? paths.join(homeDirectory, "AppData", "Local");
      const config = paths.join(appData, APPLICATION_DIRECTORY);
      const state = paths.join(localAppData, APPLICATION_DIRECTORY);
      const install = paths.join(localAppData, "Programs", APPLICATION_DIRECTORY);
      return {
        config,
        state,
        evidence: paths.join(state, "evidence"),
        backup,
        install,
        executable: paths.join(install, `${APPLICATION_DIRECTORY}.exe`),
      };
    }
  }
}

function defaultCommandResultRunner(command: PlatformCommand): Promise<PlatformCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.arguments, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearCommandTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearCommandTimeout(timeout);
      const commandStderr = commandResultStderr({
        exitCode,
        signal,
        stderr,
        timedOut,
        timeoutMs: command.timeout_ms,
      });
      resolve({
        exitCode: timedOut ? 124 : (exitCode ?? 1),
        stderr: commandStderr,
        stdout,
      });
    });
    if (command.timeout_ms !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, command.timeout_ms);
    }
  });
}

async function defaultCommandRunner(command: PlatformCommand): Promise<void> {
  const result = await defaultCommandResultRunner(command);
  if (result.exitCode !== 0) {
    throw new Error(`${command.executable} failed: ${commandDetail(result)}`);
  }
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function replaceWindowsExecutable(
  options: ExecutableReplacementOptions,
): Promise<ExecutableReplacementOutcome> {
  let previousWasRenamed = false;
  try {
    if (options.previousExecutable !== undefined) {
      await rename(options.destination, options.previousExecutable);
      previousWasRenamed = true;
    }
    await rename(options.stagedExecutable, options.destination);
    return "replaced";
  } catch (error) {
    const moveNewBinary = `Move-Item -LiteralPath ${powerShellLiteral(options.stagedExecutable)} -Destination ${powerShellLiteral(options.destination)} -Force`;
    const finishCommand = previousWasRenamed
      ? moveNewBinary
      : options.previousExecutable === undefined
        ? moveNewBinary
        : `Move-Item -LiteralPath ${powerShellLiteral(options.destination)} -Destination ${powerShellLiteral(options.previousExecutable)} -Force; ${moveNewBinary}`;
    const state = previousWasRenamed
      ? `the previous binary remains at ${options.previousExecutable} and the new binary remains at ${options.stagedExecutable}`
      : `the installed binary remains at ${options.destination} and the new binary remains at ${options.stagedExecutable}`;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Windows could not replace ${options.destination}; ${state}. Exit every quest process, then finish the upgrade in PowerShell with: ${finishCommand} (${detail})`,
    );
  }
}

function runAndWait(
  runCommand: PlatformCommandResultRunner,
  executable: string,
  arguments_: readonly string[],
): Promise<PlatformCommandResult> {
  return runCommand({
    executable,
    arguments: arguments_,
    waitForExit: true,
  });
}

function commandDetail(result: PlatformCommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

function clearCommandTimeout(timeout: ReturnType<typeof setTimeout> | undefined): void {
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}

function commandResultStderr(input: {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly timeoutMs: number | undefined;
}): string {
  if (input.timedOut) {
    return `${input.stderr}${input.stderr === "" ? "" : "\n"}timed out after ${input.timeoutMs}ms`;
  }
  if (input.exitCode === null && input.signal !== null) {
    return `${input.stderr}${input.stderr === "" ? "" : "\n"}terminated by ${input.signal}`;
  }
  return input.stderr;
}

function parseLsofHolders(output: string): ProcessHolder[] {
  const holders = new Map<number, { command: string; paths: Set<string> }>();
  let pid: number | undefined;
  let command = "?";

  const flush = (): void => {
    if (pid === undefined) {
      return;
    }
    const current = holders.get(pid) ?? { command, paths: new Set<string>() };
    if (current.command === "?" && command !== "?") {
      current.command = command;
    }
    holders.set(pid, current);
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      flush();
      const parsedPid = Number.parseInt(line.slice(1), 10);
      pid = Number.isSafeInteger(parsedPid) ? parsedPid : undefined;
      command = "?";
      continue;
    }
    if (pid === undefined) {
      continue;
    }
    if (line.startsWith("c")) {
      command = line.slice(1).trim() || "?";
      continue;
    }
    if (line.startsWith("n")) {
      const current = holders.get(pid) ?? { command, paths: new Set<string>() };
      current.paths.add(line.slice(1));
      holders.set(pid, current);
    }
  }
  flush();

  return [...holders.entries()]
    .map(([holderPid, holder]) => ({
      command: holder.command,
      paths: [...holder.paths].sort(),
      pid: holderPid,
    }))
    .sort((left, right) => left.pid - right.pid);
}

function parseHandleHolders(output: string, path: string): ProcessHolder[] {
  const holders = new Map<number, ProcessHolder>();
  for (const line of output.split("\n")) {
    const match = line.match(/^(.+?)\s+pid:\s*(\d+)\s+type:\s+\S+\s+.+$/i);
    if (match === null) {
      continue;
    }
    const pid = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isSafeInteger(pid)) {
      continue;
    }
    const command = match[1]?.trim() || "?";
    const current = holders.get(pid);
    holders.set(pid, {
      command: current?.command === "?" || current === undefined ? command : current.command,
      paths: current === undefined ? [path] : [...new Set([...current.paths, path])].sort(),
      pid,
    });
  }
  return [...holders.values()].sort((left, right) => left.pid - right.pid);
}

async function existingProcessPaths(paths: readonly string[]): Promise<string[]> {
  const existingPaths: string[] = [];
  for (const path of paths) {
    if (await pathExists(path)) {
      existingPaths.push(path);
    }
  }
  return existingPaths;
}

function mergeProcessHolder(holders: Map<number, ProcessHolder>, holder: ProcessHolder): void {
  const current = holders.get(holder.pid);
  holders.set(holder.pid, {
    command: current?.command === "?" || current === undefined ? holder.command : current.command,
    paths:
      current === undefined
        ? holder.paths
        : [...new Set([...current.paths, ...holder.paths])].sort(),
    pid: holder.pid,
  });
}

async function inspectWindowsProcessHolders(
  paths: readonly string[],
  runCommand: PlatformCommandResultRunner,
): Promise<ProcessHoldingResult> {
  const holders = new Map<number, ProcessHolder>();
  let unavailableDetail: string | undefined;
  for (const path of paths) {
    let result: PlatformCommandResult;
    try {
      result = await runCommand({
        executable: "handle.exe",
        arguments: ["-nobanner", path],
        timeout_ms: WINDOWS_PROCESS_PROBE_TIMEOUT_MS,
        waitForExit: true,
      });
    } catch (error: unknown) {
      unavailableDetail ??= `could not run handle.exe: ${
        error instanceof Error ? error.message : String(error)
      }`;
      continue;
    }
    if (result.exitCode !== 0) {
      unavailableDetail ??= `handle.exe returned exit ${result.exitCode}: ${commandDetail(result)}`;
      continue;
    }
    for (const holder of parseHandleHolders(result.stdout, path)) {
      mergeProcessHolder(holders, holder);
    }
  }
  const knownHolders = [...holders.values()].sort((left, right) => left.pid - right.pid);
  if (unavailableDetail !== undefined) {
    return { available: false, detail: unavailableDetail, holders: knownHolders };
  }
  return {
    available: true,
    holders: knownHolders,
  };
}

async function inspectPosixProcessHolders(
  paths: readonly string[],
  runCommand: PlatformCommandResultRunner,
): Promise<ProcessHoldingResult> {
  const result = await runCommand({
    executable: "lsof",
    arguments: ["-nP", "-Fpcn", "--", ...paths],
    waitForExit: true,
  });
  if (result.exitCode !== 0 && result.stdout.trim() === "") {
    if (result.exitCode === 1 && result.stderr.trim() === "") {
      return { available: true, holders: [] };
    }
    return {
      available: false,
      detail: `lsof returned exit ${result.exitCode}: ${commandDetail(result)}`,
      holders: [],
    };
  }
  return { available: true, holders: parseLsofHolders(result.stdout) };
}

async function inspectProcessesHoldingPaths(
  platform: SupportedPlatform,
  paths: readonly string[],
  runCommand: PlatformCommandResultRunner,
): Promise<ProcessHoldingResult> {
  try {
    const existingPaths = await existingProcessPaths(paths);
    if (existingPaths.length === 0) {
      return { available: true, holders: [] };
    }
    return platform === "win32"
      ? await inspectWindowsProcessHolders(existingPaths, runCommand)
      : await inspectPosixProcessHolders(existingPaths, runCommand);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      detail: `could not inspect process holders: ${detail}`,
      holders: [],
    };
  }
}

function requireCommandSuccess(
  result: PlatformCommandResult,
  executable: string,
  operation: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${operation} failed: ${commandDetail(result)}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function validateSchedulerExecutable(definition: BackupScheduleDefinition): Promise<void> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(definition.executable);
  } catch {
    throw new Error(`scheduler executable does not exist: ${definition.executable}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`scheduler executable is not a regular file: ${definition.executable}`);
  }
  if (definition.kind !== "schtasks") {
    try {
      await access(definition.executable, constants.X_OK);
    } catch {
      throw new Error(`scheduler executable is not executable: ${definition.executable}`);
    }
  }
}

async function replaceFile(filePath: string, contents: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const temporaryPath = join(directory, `.quest-schedule-${crypto.randomUUID()}`);
  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporaryPath, filePath);
    } catch {
      await rm(filePath, { force: true });
      await rename(temporaryPath, filePath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

interface BackupScheduleDefinition {
  readonly definitionPaths: readonly string[];
  readonly executable: string;
  readonly kind: SchedulerKind;
  readonly name: string;
  readonly primaryDefinitionPath: string | null;
  readonly statusArguments: readonly string[];
  readonly statusExecutable: string;
  readonly taskName: string | null;
  readonly windowsStatusProbeExecutable: string | null;
  readonly writes: ReadonlyMap<string, string | Uint8Array>;
}

function schedulerDefaultName(platform: SupportedPlatform, userId: string): string {
  switch (platform) {
    case "darwin":
      return "com.janiorvalle.quest.backup";
    case "linux":
      return "quest-backup";
    case "win32": {
      const userSuffix = createHash("sha256")
        .update(userId.toLowerCase(), "utf8")
        .digest("hex")
        .slice(0, 16);
      return `Quest Backup - ${userSuffix}`;
    }
  }
}

function validateSchedulerName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("scheduler name must be non-empty and must not contain path separators");
  }
  return trimmed;
}

function launchdDefinition(name: string, executable: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlText(name)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlText(executable)}</string>
    <string>backup</string>
    <string>run</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
`;
}

function systemdExecutable(executable: string): string {
  return JSON.stringify(executable.replaceAll("%", "%%").replaceAll("$", "$$"));
}

function systemdServiceDefinition(executable: string): string {
  return `[Unit]
Description=Create a Quest backup

[Service]
Type=oneshot
ExecStart=${systemdExecutable(executable)} backup run
`;
}

function systemdTimerDefinition(name: string): string {
  return `[Unit]
Description=Create a daily Quest backup

[Timer]
OnCalendar=*-*-* ${BACKUP_SCHEDULE_TIME}:00
Persistent=true
Unit=${name}.service

[Install]
WantedBy=timers.target
`;
}

function utf16LeWithBom(value: string): Uint8Array {
  const bytes = new Uint8Array(2 + value.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, true);
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(2 + index * 2, value.charCodeAt(index), true);
  }
  return bytes;
}

function windowsTaskDefinition(executable: string, userId: string): Uint8Array {
  return utf16LeWithBom(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2000-01-01T${BACKUP_SCHEDULE_TIME}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlText(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlText(executable)}</Command>
      <Arguments>backup run</Arguments>
    </Exec>
  </Actions>
</Task>
`);
}

function buildBackupScheduleDefinition(options: {
  readonly directories: PlatformDirectories;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly homeDirectory: string;
  readonly name: string;
  readonly platform: SupportedPlatform;
  readonly userId: string | undefined;
}): BackupScheduleDefinition {
  const { directories, environment, executable, homeDirectory, name, platform, userId } = options;
  switch (platform) {
    case "darwin": {
      if (userId === undefined || userId.trim() === "") {
        throw new Error("user ID is required for launchd backup scheduling");
      }
      const path = posix.join(homeDirectory, "Library", "LaunchAgents", `${name}.plist`);
      return {
        definitionPaths: [path],
        executable,
        kind: "launchd",
        name,
        primaryDefinitionPath: path,
        statusArguments: ["print", `gui/${userId}/${name}`],
        statusExecutable: "launchctl",
        taskName: null,
        windowsStatusProbeExecutable: null,
        writes: new Map([[path, launchdDefinition(name, executable)]]),
      };
    }
    case "linux": {
      const configRoot =
        absoluteEnvironmentDirectory(environment, "XDG_CONFIG_HOME", posix.isAbsolute) ??
        posix.join(homeDirectory, ".config");
      const unitDirectory = posix.join(configRoot, "systemd", "user");
      const servicePath = posix.join(unitDirectory, `${name}.service`);
      const timerPath = posix.join(unitDirectory, `${name}.timer`);
      return {
        definitionPaths: [timerPath, servicePath],
        executable,
        kind: "systemd",
        name,
        primaryDefinitionPath: timerPath,
        statusArguments: ["--user", "is-enabled", `${name}.timer`],
        statusExecutable: "systemctl",
        taskName: null,
        windowsStatusProbeExecutable: null,
        writes: new Map([
          [servicePath, systemdServiceDefinition(executable)],
          [timerPath, systemdTimerDefinition(name)],
        ]),
      };
    }
    case "win32": {
      if (userId === undefined || userId.trim() === "") {
        throw new Error("user identity is required for Windows backup scheduling");
      }
      const path = win32.join(directories.config, "backup-schedule.xml");
      return {
        definitionPaths: [path],
        executable,
        kind: "schtasks",
        name,
        primaryDefinitionPath: path,
        statusArguments: ["/Query", "/TN", name],
        statusExecutable: windowsSystemPath(environment, "schtasks.exe"),
        taskName: name,
        windowsStatusProbeExecutable: windowsSystemPath(
          environment,
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        writes: new Map([[path, windowsTaskDefinition(executable, userId)]]),
      };
    }
  }
}

async function inspectBackupSchedule(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
): Promise<BackupScheduleStatus> {
  return (await inspectBackupScheduleState(definition, runCommand)).status;
}

interface InspectedBackupSchedule {
  readonly active: boolean;
  readonly definitionPresent: boolean;
  readonly enabled: boolean;
  readonly masked: boolean;
  readonly registered: boolean;
  readonly status: BackupScheduleStatus;
}

async function inspectBackupScheduleState(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
): Promise<InspectedBackupSchedule> {
  const registration = await runAndWait(
    runCommand,
    definition.statusExecutable,
    definition.statusArguments,
  );
  const registrationState = await schedulerRegistrationState(definition, registration, runCommand);
  const definitionStates = await Promise.all(
    definition.definitionPaths.map((filePath) => pathExists(filePath)),
  );
  const definitionExists =
    definition.definitionPaths.length === 0
      ? registrationState.registered
      : definition.kind === "systemd"
        ? definitionStates.every(Boolean)
        : definitionStates.some(Boolean);
  return {
    active: registrationState.active,
    definitionPresent: definitionStates.some(Boolean),
    enabled: registrationState.installed,
    masked: registrationState.masked,
    registered: registrationState.registered,
    status: {
      definition_exists: definitionExists,
      definition_path: definition.primaryDefinitionPath,
      executable: definition.executable,
      executable_exists: await pathExists(definition.executable),
      frequency: BACKUP_SCHEDULE_FREQUENCY,
      installed:
        registrationState.installed &&
        (definition.kind !== "systemd" || (registrationState.active && definitionExists)),
      kind: definition.kind,
      task_name: definition.taskName,
    },
  };
}

interface SchedulerRegistrationState {
  readonly active: boolean;
  readonly installed: boolean;
  readonly masked: boolean;
  readonly registered: boolean;
}

async function windowsSchedulerRegistrationState(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
): Promise<SchedulerRegistrationState> {
  const probeExecutable = definition.windowsStatusProbeExecutable;
  if (probeExecutable === null) {
    throw new Error("Windows scheduler status probe is unavailable");
  }
  const probe = await runAndWait(runCommand, probeExecutable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsTaskStatusProbe(definition.name),
  ]);
  if (probe.exitCode === 0) {
    return { active: true, installed: true, masked: false, registered: true };
  }
  if (probe.exitCode === 3) {
    return { active: false, installed: false, masked: false, registered: false };
  }
  if (probe.exitCode === 4) {
    return { active: false, installed: false, masked: false, registered: true };
  }
  throw new Error(`powershell.exe status probe failed: ${commandDetail(probe)}`);
}

async function systemdTimerIsActive(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
): Promise<boolean> {
  const result = await runAndWait(runCommand, "systemctl", [
    "--user",
    "is-active",
    `${definition.name}.timer`,
  ]);
  const state = result.stdout.trim();
  if (result.exitCode === 0) {
    return state === "active";
  }
  if (
    result.exitCode === 3 &&
    (state === "inactive" || state === "failed" || state === "unknown")
  ) {
    return false;
  }
  throw new Error(`systemctl status failed: ${commandDetail(result)}`);
}

async function systemdSchedulerRegistrationState(
  definition: BackupScheduleDefinition,
  result: PlatformCommandResult,
  runCommand: PlatformCommandResultRunner,
): Promise<SchedulerRegistrationState> {
  if (result.exitCode === 0) {
    return {
      active: await systemdTimerIsActive(definition, runCommand),
      installed: true,
      masked: false,
      registered: true,
    };
  }
  const state = result.stdout.trim();
  if (state === "disabled") {
    return { active: false, installed: false, masked: false, registered: true };
  }
  if (state === "masked" || state === "masked-runtime") {
    return { active: false, installed: false, masked: true, registered: true };
  }
  if (state === "not-found") {
    return { active: false, installed: false, masked: false, registered: false };
  }
  throw new Error(`${definition.statusExecutable} status failed: ${commandDetail(result)}`);
}

async function schedulerRegistrationState(
  definition: BackupScheduleDefinition,
  result: PlatformCommandResult,
  runCommand: PlatformCommandResultRunner,
): Promise<SchedulerRegistrationState> {
  if (definition.kind === "schtasks") {
    return windowsSchedulerRegistrationState(definition, runCommand);
  }
  if (definition.kind === "systemd") {
    return systemdSchedulerRegistrationState(definition, result, runCommand);
  }
  if (result.exitCode === 0) {
    return { active: true, installed: true, masked: false, registered: true };
  }
  if (result.exitCode === 113) {
    return { active: false, installed: false, masked: false, registered: false };
  }
  throw new Error(`${definition.statusExecutable} status failed: ${commandDetail(result)}`);
}

async function installBackupSchedule(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
  userId: string | undefined,
): Promise<BackupScheduleStatus> {
  await validateSchedulerExecutable(definition);
  if (definition.kind === "launchd") {
    return installLaunchdBackupSchedule(definition, runCommand, userId);
  }
  if (definition.kind === "systemd") {
    return installSystemdBackupSchedule(definition, runCommand);
  }
  for (const [filePath, contents] of definition.writes) {
    await replaceFile(filePath, contents);
  }

  switch (definition.kind) {
    case "schtasks": {
      const create = await runAndWait(runCommand, definition.statusExecutable, [
        "/Create",
        "/TN",
        definition.name,
        "/XML",
        definition.primaryDefinitionPath ?? "",
        "/F",
      ]);
      requireCommandSuccess(create, "schtasks", "create");
      break;
    }
  }
  return inspectBackupSchedule(definition, runCommand);
}

async function definitionSnapshots(
  definition: BackupScheduleDefinition,
): Promise<ReadonlyMap<string, Uint8Array | undefined>> {
  const snapshots = new Map<string, Uint8Array | undefined>();
  for (const filePath of definition.definitionPaths) {
    snapshots.set(filePath, (await pathExists(filePath)) ? await readFile(filePath) : undefined);
  }
  return snapshots;
}

async function restoreSystemdDefinitionSnapshots(
  definition: BackupScheduleDefinition,
  previous: InspectedBackupSchedule,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
): Promise<void> {
  for (const [filePath, contents] of snapshots) {
    if (previous.masked && filePath === definition.primaryDefinitionPath) {
      await rm(filePath, { force: true });
    } else if (contents === undefined) {
      await rm(filePath, { force: true });
    } else {
      await replaceFile(filePath, contents);
    }
  }
}

async function rollbackSystemdBackupSchedule(options: {
  readonly definition: BackupScheduleDefinition;
  readonly error: unknown;
  readonly previous: InspectedBackupSchedule;
  readonly snapshots: ReadonlyMap<string, Uint8Array | undefined>;
  readonly runCommand: PlatformCommandResultRunner;
}): Promise<void> {
  try {
    await restoreSystemdDefinitionSnapshots(
      options.definition,
      options.previous,
      options.snapshots,
    );
    const reload = await runAndWait(options.runCommand, "systemctl", ["--user", "daemon-reload"]);
    requireCommandSuccess(reload, "systemctl", "rollback daemon-reload");
    const timer = `${options.definition.name}.timer`;
    if (options.previous.masked) {
      const mask = await runAndWait(options.runCommand, "systemctl", ["--user", "mask", timer]);
      requireCommandSuccess(mask, "systemctl", "rollback mask");
    } else if (options.previous.registered) {
      const restoreRegistration = await runAndWait(options.runCommand, "systemctl", [
        "--user",
        options.previous.enabled ? "enable" : "disable",
        ...(options.previous.active ? ["--now"] : []),
        timer,
      ]);
      requireCommandSuccess(restoreRegistration, "systemctl", "rollback registration");
    }
  } catch (rollbackError) {
    const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new Error(`systemd schedule refresh failed and rollback failed: ${detail}`, {
      cause: options.error,
    });
  }
}

async function installSystemdBackupSchedule(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
): Promise<BackupScheduleStatus> {
  const previous = await inspectBackupScheduleState(definition, runCommand);
  const snapshots = await definitionSnapshots(definition);
  try {
    for (const [filePath, contents] of definition.writes) {
      await replaceFile(filePath, contents);
    }
    const reload = await runAndWait(runCommand, "systemctl", ["--user", "daemon-reload"]);
    requireCommandSuccess(reload, "systemctl", "daemon-reload");
    const enable = await runAndWait(runCommand, "systemctl", [
      "--user",
      "enable",
      "--now",
      `${definition.name}.timer`,
    ]);
    requireCommandSuccess(enable, "systemctl", "enable");
  } catch (error) {
    await rollbackSystemdBackupSchedule({
      definition,
      error,
      previous,
      runCommand,
      snapshots,
    });
    throw error;
  }
  return inspectBackupSchedule(definition, runCommand);
}

async function installLaunchdBackupSchedule(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
  userId: string | undefined,
): Promise<BackupScheduleStatus> {
  if (userId === undefined) {
    throw new Error("user ID is required for launchd backup scheduling");
  }
  const definitionPath = definition.primaryDefinitionPath;
  const contents = definitionPath === null ? undefined : definition.writes.get(definitionPath);
  if (definitionPath === null || contents === undefined) {
    throw new Error("launchd backup schedule definition is missing");
  }

  const previousDefinition = (await pathExists(definitionPath))
    ? await readFile(definitionPath)
    : undefined;
  const previousStatus = await runAndWait(runCommand, "launchctl", [
    "print",
    `gui/${userId}/${definition.name}`,
  ]);
  const wasRegistered = launchdWasRegistered(previousStatus);

  await replaceFile(definitionPath, contents);
  try {
    const bootout = await runAndWait(runCommand, "launchctl", [
      "bootout",
      `gui/${userId}/${definition.name}`,
    ]);
    if (wasRegistered) {
      requireCommandSuccess(bootout, "launchctl", "bootout");
    }
    await registerLaunchdDefinition(definitionPath, userId, runCommand);
  } catch (error) {
    await rollbackLaunchdBackupSchedule({
      definition,
      definitionPath,
      error,
      previousDefinition,
      runCommand,
      userId,
      wasRegistered,
    });
    throw error;
  }
  return inspectBackupSchedule(definition, runCommand);
}

function launchdWasRegistered(result: PlatformCommandResult): boolean {
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 113) {
    return false;
  }
  throw new Error(`launchctl status failed: ${commandDetail(result)}`);
}

async function rollbackLaunchdBackupSchedule(options: {
  readonly definition: BackupScheduleDefinition;
  readonly definitionPath: string;
  readonly error: unknown;
  readonly previousDefinition: Uint8Array | undefined;
  readonly runCommand: PlatformCommandResultRunner;
  readonly userId: string;
  readonly wasRegistered: boolean;
}): Promise<void> {
  await runAndWait(options.runCommand, "launchctl", [
    "bootout",
    `gui/${options.userId}/${options.definition.name}`,
  ]);
  if (options.previousDefinition === undefined) {
    await rm(options.definitionPath, { force: true });
  } else {
    await replaceFile(options.definitionPath, options.previousDefinition);
  }
  if (!options.wasRegistered || options.previousDefinition === undefined) {
    return;
  }
  try {
    await registerLaunchdDefinition(options.definitionPath, options.userId, options.runCommand);
  } catch (rollbackError) {
    const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new Error(`launchd schedule refresh failed and rollback failed: ${detail}`, {
      cause: options.error,
    });
  }
}

async function registerLaunchdDefinition(
  definitionPath: string,
  userId: string,
  runCommand: PlatformCommandResultRunner,
): Promise<void> {
  const bootstrap = await runAndWait(runCommand, "launchctl", [
    "bootstrap",
    `gui/${userId}`,
    definitionPath,
  ]);
  if (bootstrap.exitCode === 0) {
    return;
  }
  const fallback = await runAndWait(runCommand, "launchctl", ["load", "-w", definitionPath]);
  requireCommandSuccess(fallback, "launchctl", "load");
}

async function removeSystemdBackupSchedule(
  definition: BackupScheduleDefinition,
  inspection: InspectedBackupSchedule,
  runCommand: PlatformCommandResultRunner,
): Promise<void> {
  if (!inspection.registered) {
    return;
  }
  if (inspection.masked) {
    const unmask = await runAndWait(runCommand, "systemctl", [
      "--user",
      "unmask",
      `${definition.name}.timer`,
    ]);
    requireCommandSuccess(unmask, "systemctl", "unmask");
    for (const [filePath, contents] of definition.writes) {
      await replaceFile(filePath, contents);
    }
    const reload = await runAndWait(runCommand, "systemctl", ["--user", "daemon-reload"]);
    requireCommandSuccess(reload, "systemctl", "daemon-reload");
  }
  const disable = await runAndWait(runCommand, "systemctl", [
    "--user",
    "disable",
    "--now",
    `${definition.name}.timer`,
  ]);
  requireCommandSuccess(disable, "systemctl", "disable");
}

async function removeBackupSchedule(
  definition: BackupScheduleDefinition,
  runCommand: PlatformCommandResultRunner,
  userId: string | undefined,
): Promise<BackupScheduleStatus> {
  const inspection = await inspectBackupScheduleState(definition, runCommand);
  const before = inspection.status;
  switch (definition.kind) {
    case "launchd":
      if (before.installed) {
        if (userId === undefined) {
          throw new Error("user ID is required for launchd backup scheduling");
        }
        const bootout = await runAndWait(runCommand, "launchctl", [
          "bootout",
          `gui/${userId}/${definition.name}`,
        ]);
        requireCommandSuccess(bootout, "launchctl", "bootout");
      }
      break;
    case "systemd":
      await removeSystemdBackupSchedule(definition, inspection, runCommand);
      break;
    case "schtasks":
      if (inspection.registered) {
        const remove = await runAndWait(runCommand, definition.statusExecutable, [
          "/Delete",
          "/TN",
          definition.name,
          "/F",
        ]);
        requireCommandSuccess(remove, "schtasks", "delete");
      }
      break;
  }

  for (const filePath of definition.definitionPaths) {
    await rm(filePath, { force: true });
  }
  if (definition.kind === "systemd" && inspection.definitionPresent) {
    const reload = await runAndWait(runCommand, "systemctl", ["--user", "daemon-reload"]);
    requireCommandSuccess(reload, "systemctl", "daemon-reload");
  }
  return inspectBackupSchedule(definition, runCommand);
}

function createBackupScheduler(options: {
  readonly definition: BackupScheduleDefinition;
  readonly runCommand: PlatformCommandResultRunner;
  readonly userId: string | undefined;
}): BackupScheduler {
  return {
    kind: options.definition.kind,
    install: () => installBackupSchedule(options.definition, options.runCommand, options.userId),
    status: () => inspectBackupSchedule(options.definition, options.runCommand),
    remove: () => removeBackupSchedule(options.definition, options.runCommand, options.userId),
  };
}

function schedulerUserId(
  platform: SupportedPlatform,
  environment: Readonly<Record<string, string | undefined>>,
  configuredUserId: string | undefined,
): string {
  if (configuredUserId !== undefined) {
    return configuredUserId;
  }
  if (platform === "win32") {
    const username = caseInsensitiveEnvironmentValue(environment, "USERNAME");
    const userDomain = caseInsensitiveEnvironmentValue(environment, "USERDOMAIN");
    const computerName = caseInsensitiveEnvironmentValue(environment, "COMPUTERNAME");
    const domain = userDomain?.toLowerCase() === "workgroup" ? computerName : userDomain;
    if (username !== undefined) {
      return domain === undefined ? username : `${domain}\\${username}`;
    }
    return "0";
  }
  return nonEmptyEnvironmentValue(environment, "UID") ?? process.getuid?.().toString() ?? "0";
}

function configuredBackupScheduler(options: {
  readonly directories: PlatformDirectories;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly platform: SupportedPlatform;
  readonly runCommand: PlatformCommandResultRunner;
  readonly schedulerExecutable: string | undefined;
  readonly schedulerName: string | undefined;
  readonly userId: string | undefined;
}): BackupScheduler {
  const paths = options.platform === "win32" ? win32 : posix;
  const executable = options.schedulerExecutable ?? options.directories.executable;
  if (!paths.isAbsolute(executable)) {
    throw new Error(`scheduler executable must be absolute: ${executable}`);
  }
  const userId = schedulerUserId(options.platform, options.environment, options.userId);
  const name = validateSchedulerName(
    options.schedulerName ?? schedulerDefaultName(options.platform, userId),
  );
  return createBackupScheduler({
    definition: buildBackupScheduleDefinition({
      directories: options.directories,
      environment: options.environment,
      executable,
      homeDirectory: options.homeDirectory,
      name,
      platform: options.platform,
      userId,
    }),
    runCommand: options.runCommand,
    userId,
  });
}

function environmentPath(
  platform: SupportedPlatform,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (platform !== "win32") {
    for (const [name, value] of Object.entries(environment)) {
      if (name === "PATH") {
        return value;
      }
    }
    return undefined;
  }
  for (const [name, value] of Object.entries(environment)) {
    if (name.toLowerCase() === "path") {
      return value;
    }
  }
  return undefined;
}

function unquotePathEntry(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function comparablePath(platform: SupportedPlatform, paths: typeof posix, value: string): string {
  let normalized = paths.normalize(unquotePathEntry(value));
  const root = paths.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(paths.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function evidenceOpenCommand(
  platform: SupportedPlatform,
  environment: Readonly<Record<string, string | undefined>>,
  filePath: string,
  workingDirectory: string,
): PlatformCommand {
  if (filePath.trim() === "") {
    throw new Error("evidence path must not be empty");
  }

  switch (platform) {
    case "darwin":
      return { executable: "open", arguments: [posix.resolve(workingDirectory, filePath)] };
    case "linux":
      return { executable: "xdg-open", arguments: [posix.resolve(workingDirectory, filePath)] };
    case "win32":
      return {
        executable: windowsSystemPath(environment, "rundll32.exe"),
        arguments: ["url.dll,FileProtocolHandler", win32.resolve(workingDirectory, filePath)],
      };
  }
}

function urlOpenCommand(
  platform: SupportedPlatform,
  environment: Readonly<Record<string, string | undefined>>,
  url: string,
): PlatformCommand {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL must use the http or https scheme");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use the http or https scheme");
  }
  const safeUrl = parsed.href;

  switch (platform) {
    case "darwin":
      return { executable: "open", arguments: [safeUrl] };
    case "linux":
      return { executable: "xdg-open", arguments: [safeUrl] };
    case "win32":
      return {
        executable: windowsSystemPath(environment, "rundll32.exe"),
        arguments: ["url.dll,FileProtocolHandler", safeUrl],
      };
  }
}

export function createPlatform(options: PlatformModuleOptions = {}): PlatformModule {
  const name = supportedPlatform(options.platform ?? process.platform);
  const environment = options.environment ?? process.env;
  const paths = name === "win32" ? win32 : posix;
  const homeDirectory = options.homeDirectory ?? homedir();
  const directories = platformDirectories(name, environment, homeDirectory);
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const runCommandAndWait = options.runCommandAndWait ?? defaultCommandResultRunner;
  const scheduler = configuredBackupScheduler({
    directories,
    environment,
    homeDirectory,
    platform: name,
    runCommand: runCommandAndWait,
    schedulerExecutable: options.schedulerExecutable,
    schedulerName: options.schedulerName,
    userId: options.userId,
  });
  const defaultSearchPath = environmentPath(name, environment);

  const isInstallDirectoryOnPath = (searchPath = defaultSearchPath): boolean => {
    if (searchPath === undefined || searchPath === "") {
      return false;
    }
    const expected = comparablePath(name, paths, directories.install);
    return searchPath
      .split(paths.delimiter)
      .some((entry) => comparablePath(name, paths, entry) === expected);
  };

  const addInstallDirectoryToPath = (searchPath = defaultSearchPath): string => {
    if (searchPath === undefined || searchPath === "") {
      return directories.install;
    }
    return isInstallDirectoryOnPath(searchPath)
      ? searchPath
      : `${directories.install}${paths.delimiter}${searchPath}`;
  };

  const createEvidenceOpenCommand = (filePath: string): PlatformCommand =>
    evidenceOpenCommand(name, environment, filePath, workingDirectory);
  const createUrlOpenCommand = (url: string): PlatformCommand =>
    urlOpenCommand(name, environment, url);

  return {
    name,
    directories,
    inspectProcessesHoldingPaths: (paths) =>
      inspectProcessesHoldingPaths(name, paths, runCommandAndWait),
    scheduler,
    evidenceOpenCommand: createEvidenceOpenCommand,
    openEvidence: (filePath) => runCommand(createEvidenceOpenCommand(filePath)),
    urlOpenCommand: createUrlOpenCommand,
    openUrl: (url) => runCommand(createUrlOpenCommand(url)),
    ...(name === "win32" ? { replaceExecutable: replaceWindowsExecutable } : {}),
    isInstallDirectoryOnPath,
    addInstallDirectoryToPath,
  };
}
