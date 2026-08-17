import { Database } from "bun:sqlite";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { SQLITE_SCHEMA_VERSION } from "../src/store";
import { artifactName, resolveDistVersion, selectDistTargets } from "./dist-config";

const rootDirectory = resolve(import.meta.dir, "..");
const { PATH: systemPath, QUEST_TARGET: targetId, QUEST_VERSION: environmentVersion } = process.env;
const version = resolveDistVersion(environmentVersion);
const selectedTargets = selectDistTargets(targetId);
const hostTargetId =
  process.platform === "darwin"
    ? `darwin-${process.arch}`
    : process.platform === "linux"
      ? `linux-${process.arch}`
      : process.platform === "win32"
        ? `windows-${process.arch}`
        : undefined;
const hostTarget = selectedTargets.find((target) => target.id === hostTargetId);

if (hostTarget === undefined) {
  throw new Error(
    `selected distribution targets do not contain host target ${hostTargetId ?? "unknown"}`,
  );
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "quest-install-smoke-"));
const installDirectory = join(temporaryDirectory, "bin");
const machineHome = join(temporaryDirectory, "machine-home");
const machineConfig = join(temporaryDirectory, "machine-config");
const machineState = join(temporaryDirectory, "machine-state");
const discoveredStoreDirectory =
  process.platform === "darwin"
    ? join(machineHome, ".local", "state", "quest")
    : join(machineState, "quest");
await mkdir(discoveredStoreDirectory, { recursive: true });
const discoveredStore = join(discoveredStoreDirectory, "quest.db");
const oldStore = new Database(discoveredStore, { create: true });
oldStore.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION - 1}`);
oldStore.close();
const name = artifactName(version, hostTarget);
const installerEnvironment = {
  ...process.env,
  APPDATA: machineConfig,
  HOME: machineHome,
  LOCALAPPDATA: machineState,
  QUEST_INSTALL_ARTIFACT: join(rootDirectory, "dist", name),
  QUEST_INSTALL_CHECKSUMS: join(rootDirectory, "dist", "checksums.txt"),
  QUEST_INSTALL_DIR: installDirectory,
  QUEST_INSTALL_SKIP_PATH: "1",
  QUEST_INSTALL_VERSION: version,
  USERPROFILE: machineHome,
  XDG_CONFIG_HOME: machineConfig,
  XDG_STATE_HOME: machineState,
};

async function runInstaller(environment: typeof installerEnvironment): Promise<number> {
  const installCommand =
    process.platform === "win32"
      ? ["pwsh", "-NoProfile", "-File", join(rootDirectory, "install.ps1")]
      : ["sh", join(rootDirectory, "install.sh")];
  const install = Bun.spawn({
    cmd: installCommand,
    env: environment,
    stderr: "inherit",
    stdout: "inherit",
  });
  return install.exited;
}

async function runPowerShellInstaller(
  environment: typeof installerEnvironment,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const install = Bun.spawn({
    cmd: ["pwsh", "-NoProfile", "-File", join(rootDirectory, "install.ps1")],
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
    new Response(install.stdout).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function createPowerShellArtifact(
  directory: string,
  script: string,
): Promise<{ readonly artifact: string; readonly checksums: string }> {
  await mkdir(directory, { recursive: true });
  const windowsArtifactName = `quest-${version}-windows-x64.exe`;
  const artifact = join(directory, windowsArtifactName);
  await writeFile(artifact, script);
  await chmod(artifact, 0o755);
  return { artifact, checksums: await writePowerShellChecksums(directory, artifact) };
}

async function writePowerShellChecksums(directory: string, artifact: string): Promise<string> {
  const digest = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(await Bun.file(artifact).arrayBuffer()))
    .digest("hex");
  const checksums = join(directory, "checksums.txt");
  await writeFile(checksums, `${digest}  ${basename(artifact)}\n`);
  return checksums;
}

async function createFailingPowerShellArtifact(): Promise<{
  readonly artifact: string;
  readonly checksums: string;
  readonly expectedOutput: string;
  readonly installVersion: string;
}> {
  const directory = join(temporaryDirectory, "powershell-failing");
  if (process.platform !== "win32") {
    const fixture = await createPowerShellArtifact(
      directory,
      "#!/bin/sh\nprintf 'store is broken; run quest migrate\\n' >&2\nexit 7\n",
    );
    return {
      ...fixture,
      expectedOutput: "store is broken; run quest migrate",
      installVersion: version,
    };
  }

  const installVersion = `${version}-mismatch`;
  await mkdir(directory, { recursive: true });
  const artifact = join(directory, `quest-${installVersion}-windows-x64.exe`);
  await copyFile(installerEnvironment.QUEST_INSTALL_ARTIFACT, artifact);
  return {
    artifact,
    checksums: await writePowerShellChecksums(directory, artifact),
    expectedOutput: `quest ${version}`,
    installVersion,
  };
}

async function runPowerShellFailureSmoke(): Promise<void> {
  if (Bun.which("pwsh") === null) {
    if (process.platform === "win32") {
      throw new Error("PowerShell is required to test install.ps1");
    }
    process.stdout.write("Skipped install.ps1 smoke because pwsh is unavailable\n");
    return;
  }

  if (process.platform !== "win32") {
    const passingFixture = await createPowerShellArtifact(
      join(temporaryDirectory, "powershell-passing"),
      `#!/bin/sh\nprintf 'quest ${version}\\n'\n`,
    );
    const passing = await runPowerShellInstaller({
      ...installerEnvironment,
      QUEST_INSTALL_ARTIFACT: passingFixture.artifact,
      QUEST_INSTALL_CHECKSUMS: passingFixture.checksums,
      QUEST_INSTALL_DIR: join(temporaryDirectory, "powershell-bin"),
    });
    if (passing.exitCode !== 0) {
      throw new Error(`install.ps1 failed with an old discovered store: ${passing.output.trim()}`);
    }
  }

  const failingFixture = await createFailingPowerShellArtifact();
  const failing = await runPowerShellInstaller({
    ...installerEnvironment,
    QUEST_INSTALL_ARTIFACT: failingFixture.artifact,
    QUEST_INSTALL_CHECKSUMS: failingFixture.checksums,
    QUEST_INSTALL_DIR: join(temporaryDirectory, "powershell-failing-bin"),
    QUEST_INSTALL_VERSION: failingFixture.installVersion,
  });
  if (failing.exitCode === 0) {
    throw new Error("install.ps1 accepted an executable that failed its version smoke test");
  }
  const failureOutput = stripVTControlCharacters(failing.output).replace(/\s+/g, " ");
  if (!failureOutput.includes(failingFixture.expectedOutput)) {
    throw new Error(`install.ps1 hid the smoke-test output: ${failing.output.trim()}`);
  }
  if (!failureOutput.toLowerCase().includes("retry the installer")) {
    throw new Error(
      `install.ps1 did not provide an actionable next step: ${failing.output.trim()}`,
    );
  }
  if (failureOutput.includes("null-valued expression")) {
    throw new Error(
      `install.ps1 replaced the real error with a null error: ${failing.output.trim()}`,
    );
  }
}

async function runPrivateInstallerSmoke(): Promise<void> {
  const artifactBytes = new Uint8Array(
    await Bun.file(installerEnvironment.QUEST_INSTALL_ARTIFACT).arrayBuffer(),
  );
  const checksumText = await Bun.file(installerEnvironment.QUEST_INSTALL_CHECKSUMS).text();
  const requests: Array<{
    readonly accept: string | null;
    readonly authorization: string | null;
    readonly path: string;
  }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const requestReceipt = {
        accept: request.headers.get("accept"),
        authorization: request.headers.get("authorization"),
        path: url.pathname,
      };
      requests.push(requestReceipt);
      if (requestReceipt.authorization !== "Bearer install-smoke-token") {
        return new Response("missing token", { status: 401 });
      }
      if (
        requestReceipt.path === `/repos/test/repo/releases/tags/v${version}` ||
        requestReceipt.path === "/repos/test/repo/releases/latest"
      ) {
        const artifactUrl = new URL(
          "/repos/test/repo/releases/assets/artifact",
          request.url,
        ).toString();
        const checksumsUrl = new URL(
          "/repos/test/repo/releases/assets/checksums",
          request.url,
        ).toString();
        return new Response(
          JSON.stringify(
            {
              assets: [
                {
                  url: artifactUrl,
                  name,
                  browser_download_url: artifactUrl,
                },
                {
                  url: checksumsUrl,
                  name: "checksums.txt",
                  browser_download_url: checksumsUrl,
                },
              ],
              html_url: new URL(`/repos/test/repo/releases/v${version}`, request.url).toString(),
              tag_name: `v${version}`,
            },
            null,
            2,
          ),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (requestReceipt.path === "/repos/test/repo/releases/assets/artifact") {
        if (!requestReceipt.accept?.includes("application/octet-stream")) {
          return new Response("missing asset accept header", { status: 406 });
        }
        return new Response(artifactBytes);
      }
      if (requestReceipt.path === "/repos/test/repo/releases/assets/checksums") {
        if (!requestReceipt.accept?.includes("application/octet-stream")) {
          return new Response("missing asset accept header", { status: 406 });
        }
        return new Response(checksumText);
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const remoteEnvironment = {
      ...installerEnvironment,
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      QUEST_GITHUB_TOKEN: "install-smoke-token",
      QUEST_INSTALL_API_BASE_URL: server.url.toString().replace(/\/$/u, ""),
      QUEST_INSTALL_ARTIFACT: "",
      QUEST_INSTALL_BASE_URL: "",
      QUEST_INSTALL_CHECKSUMS: "",
      QUEST_INSTALL_DIR: join(temporaryDirectory, "private-bin"),
      QUEST_INSTALL_REPO: "test/repo",
    };
    if ((await runInstaller(remoteEnvironment)) !== 0) {
      throw new Error("private-release installer failed");
    }
    const assetRequests = requests.filter((request) => request.path.includes("/releases/assets/"));
    if (assetRequests.length !== 2) {
      throw new Error(`private-release installer made ${assetRequests.length} asset requests`);
    }
    if (requests.some((request) => request.path.includes("/releases/download/"))) {
      throw new Error("private-release installer used a browser download URL");
    }
  } finally {
    server.stop(true);
  }
}

const environmentWithoutPath = Object.fromEntries(
  Object.entries(installerEnvironment).filter(([key]) => key.toUpperCase() !== "PATH"),
);
const smokeEnvironment = {
  ...environmentWithoutPath,
  PATH: `${installDirectory}${delimiter}${systemPath ?? ""}`,
};

try {
  if ((await runInstaller(installerEnvironment)) !== 0) {
    throw new Error("installer failed");
  }

  const executable = process.platform === "win32" ? "quest.exe" : "quest";
  const oldStoreSmoke = Bun.spawn({
    cmd: [executable, "--version"],
    env: smokeEnvironment,
    stderr: "inherit",
    stdout: "pipe",
  });
  const oldStoreOutput = await new Response(oldStoreSmoke.stdout).text();
  if ((await oldStoreSmoke.exited) !== 0 || oldStoreOutput.trim() !== `quest ${version}`) {
    throw new Error("installed quest --version failed with an old discovered store");
  }

  await writeFile(discoveredStore, "not a SQLite database");
  if ((await runInstaller(installerEnvironment)) !== 0) {
    throw new Error(
      "installer failed when replacing an existing installation with a corrupt store",
    );
  }

  const smoke = Bun.spawn({
    cmd: [executable, "--version"],
    env: smokeEnvironment,
    stderr: "inherit",
    stdout: "pipe",
  });
  const output = await new Response(smoke.stdout).text();
  if ((await smoke.exited) !== 0) {
    throw new Error("installed quest --version failed");
  }
  if (output.trim() !== `quest ${version}`) {
    throw new Error(`installed quest reported unexpected version ${JSON.stringify(output.trim())}`);
  }

  await runPrivateInstallerSmoke();
  await runPowerShellFailureSmoke();

  const untrustedDirectory = join(temporaryDirectory, "untrusted-cwd");
  const preloadMarker = join(untrustedDirectory, "preload-ran");
  await mkdir(untrustedDirectory);
  await writeFile(join(untrustedDirectory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await writeFile(
    join(untrustedDirectory, "preload.ts"),
    'await Bun.write("preload-ran", "unsafe");\n',
  );
  const untrustedSmoke = Bun.spawn({
    cmd: [executable, "--version"],
    cwd: untrustedDirectory,
    env: smokeEnvironment,
    stderr: "inherit",
    stdout: "pipe",
  });
  await new Response(untrustedSmoke.stdout).text();
  if ((await untrustedSmoke.exited) !== 0) {
    throw new Error("installed quest failed inside a repository with bunfig.toml");
  }
  if (await Bun.file(preloadMarker).exists()) {
    throw new Error("installed quest executed a cwd-provided bunfig preload");
  }

  const corruptArtifact = join(temporaryDirectory, name);
  await copyFile(installerEnvironment.QUEST_INSTALL_ARTIFACT, corruptArtifact);
  await appendFile(corruptArtifact, "corrupt");
  const corruptInstall = await runInstaller({
    ...installerEnvironment,
    QUEST_INSTALL_ARTIFACT: corruptArtifact,
    QUEST_INSTALL_DIR: join(temporaryDirectory, "corrupt-bin"),
  });
  if (corruptInstall === 0) {
    throw new Error("installer accepted an artifact with a checksum mismatch");
  }

  process.stdout.write(`${output.trim()} passed from a fresh PATH install\n`);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
