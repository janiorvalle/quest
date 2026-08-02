import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

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
const name = artifactName(version, hostTarget);
const installerEnvironment = {
  ...process.env,
  QUEST_INSTALL_ARTIFACT: join(rootDirectory, "dist", name),
  QUEST_INSTALL_CHECKSUMS: join(rootDirectory, "dist", "checksums.txt"),
  QUEST_INSTALL_DIR: installDirectory,
  QUEST_INSTALL_SKIP_PATH: "1",
  QUEST_INSTALL_VERSION: version,
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
  Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
);
const smokeEnvironment = {
  ...environmentWithoutPath,
  PATH: `${installDirectory}${delimiter}${systemPath ?? ""}`,
};

try {
  if ((await runInstaller(installerEnvironment)) !== 0) {
    throw new Error("installer failed");
  }
  if ((await runInstaller(installerEnvironment)) !== 0) {
    throw new Error("installer failed when replacing an existing installation");
  }

  const executable = process.platform === "win32" ? "quest.exe" : "quest";
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
