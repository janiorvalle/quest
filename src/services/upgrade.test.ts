import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { UpgradeFileSystem, UpgradeHttpClient } from "./upgrade";
import { createUpgradeOperations } from "./upgrade";

const releaseUrl = "https://github.com/owner/repo/releases/tag/v0.8.1";
const artifactUrl =
  "https://github.com/owner/repo/releases/download/v0.8.1/quest-0.8.1-darwin-arm64";
const checksumsUrl = "https://github.com/owner/repo/releases/download/v0.8.1/checksums.txt";
const artifactApiUrl = "https://api.github.com/repos/owner/repo/releases/assets/123";
const checksumsApiUrl = "https://api.github.com/repos/owner/repo/releases/assets/456";
const latestUrl = "https://api.github.com/repos/owner/repo/releases/latest";

function response(body: string | Uint8Array, status = 200): Response {
  if (typeof body === "string") {
    return new Response(body, { status });
  }
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return new Response(copy, { status });
}

function releasePayload(version = "0.8.1"): string {
  return JSON.stringify({
    assets: [
      {
        browser_download_url: artifactUrl.replace("0.8.1", version),
        name: `quest-${version}-darwin-arm64`,
        url: artifactApiUrl,
      },
      {
        browser_download_url: checksumsUrl.replace("0.8.1", version),
        name: "checksums.txt",
        url: checksumsApiUrl,
      },
    ],
    html_url: releaseUrl.replace("0.8.1", version),
    tag_name: `v${version}`,
  });
}

function httpClient(
  responses: ReadonlyMap<string, Response>,
  requested: string[],
): UpgradeHttpClient {
  return {
    request: async (url) => {
      requested.push(url);
      const result = responses.get(url);
      if (result === undefined) {
        throw new Error(`unexpected request: ${url}`);
      }
      return result;
    },
  };
}

function fakeFileSystem(options: { readonly failFirstMove?: boolean } = {}) {
  const calls: string[] = [];
  let moveCount = 0;
  const fileSystem = {
    chmodExecutable: async (path: string) => {
      calls.push(`chmod:${path}`);
    },
    copyFile: async (source: string, destination: string) => {
      calls.push(`copy:${source}->${destination}`);
    },
    createDirectory: async (path: string) => {
      calls.push(`mkdir:${path}`);
    },
    createTemporaryDirectory: async (parent: string) => {
      calls.push(`mktemp:${parent}`);
      return `${parent}/.quest-upgrade-123`;
    },
    fileExists: async () => true,
    move: async (source: string, destination: string) => {
      moveCount += 1;
      calls.push(`move:${source}->${destination}`);
      if (options.failFirstMove && moveCount === 1) {
        throw new Error("move failed");
      }
    },
    removeDirectory: async (path: string) => {
      calls.push(`rmdir:${path}`);
    },
    removeFile: async (path: string) => {
      calls.push(`rm:${path}`);
    },
    writeFile: async (path: string) => {
      calls.push(`write:${path}`);
    },
  } satisfies UpgradeFileSystem;
  return { calls, fileSystem };
}

describe("upgrade service", () => {
  test("checks the latest release without downloading an artifact", async () => {
    const requested: string[] = [];
    const operations = createUpgradeOperations({
      architecture: "arm64",
      executablePath: "/install/quest",
      httpClient: httpClient(new Map([[latestUrl, response(releasePayload())]]), requested),
      platform: "darwin",
      repository: "owner/repo",
    });

    await expect(operations.check("0.8.0")).resolves.toEqual({
      artifact: "quest-0.8.1-darwin-arm64",
      artifact_url: artifactUrl,
      current_version: "0.8.0",
      latest_version: "0.8.1",
      release_url: releaseUrl,
      repository: "owner/repo",
      target: "darwin-arm64",
      update_available: true,
    });
    expect(requested).toEqual([latestUrl]);
  });

  test("adds bearer authentication for private release metadata", async () => {
    const originalFetch = globalThis.fetch;
    const requestHeaders: Headers[] = [];
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestHeaders.push(new Headers(init?.headers));
        return response(releasePayload());
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const operations = createUpgradeOperations({
        architecture: "arm64",
        executablePath: "/install/quest",
        platform: "darwin",
        repository: "owner/repo",
        token: "test-token",
      });
      await expect(operations.check("0.8.0")).resolves.toMatchObject({
        latest_version: "0.8.1",
        update_available: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestHeaders).toHaveLength(1);
    expect(requestHeaders[0]?.get("Authorization")).toBe("Bearer test-token");
  });

  test("verifies the checksum and unlinks before renaming the staged binary", async () => {
    const artifact = new TextEncoder().encode("quest 0.8.1");
    const checksum = createHash("sha256").update(artifact).digest("hex");
    const requested: string[] = [];
    const { calls, fileSystem } = fakeFileSystem();
    const operations = createUpgradeOperations({
      architecture: "arm64",
      executablePath: "/install/quest",
      fileSystem,
      httpClient: httpClient(
        new Map([
          [latestUrl, response(releasePayload())],
          [artifactApiUrl, response(artifact)],
          [checksumsApiUrl, response(`${checksum}  quest-0.8.1-darwin-arm64\n`)],
        ]),
        requested,
      ),
      platform: "darwin",
      repository: "owner/repo",
    });

    await expect(operations.install("0.8.0")).resolves.toMatchObject({
      checksum,
      current_version: "0.8.0",
      installed: true,
      latest_version: "0.8.1",
      update_available: true,
    });
    expect(requested).toEqual([latestUrl, artifactApiUrl, checksumsApiUrl]);
    expect(calls.indexOf("rm:/install/quest")).toBeLessThan(
      calls.findIndex((call) => call.startsWith("move:")),
    );
  });

  test("refuses a checksum mismatch before touching the installed binary", async () => {
    const requested: string[] = [];
    const { calls, fileSystem } = fakeFileSystem();
    const operations = createUpgradeOperations({
      architecture: "arm64",
      executablePath: "/install/quest",
      fileSystem,
      httpClient: httpClient(
        new Map([
          [latestUrl, response(releasePayload())],
          [artifactApiUrl, response(new TextEncoder().encode("tampered"))],
          [checksumsApiUrl, response(`${"0".repeat(64)}  quest-0.8.1-darwin-arm64\n`)],
        ]),
        requested,
      ),
      platform: "darwin",
      repository: "owner/repo",
    });

    await expect(operations.install("0.8.0")).rejects.toThrow("UPGRADE_CHECKSUM_MISMATCH");
    expect(calls).toEqual([]);
  });

  test("restores the previous binary when the replacement move fails", async () => {
    const artifact = new TextEncoder().encode("quest 0.8.1");
    const checksum = createHash("sha256").update(artifact).digest("hex");
    const { calls, fileSystem } = fakeFileSystem({ failFirstMove: true });
    const operations = createUpgradeOperations({
      architecture: "arm64",
      executablePath: "/install/quest",
      fileSystem,
      httpClient: httpClient(
        new Map([
          [latestUrl, response(releasePayload())],
          [artifactApiUrl, response(artifact)],
          [checksumsApiUrl, response(`${checksum}  quest-0.8.1-darwin-arm64\n`)],
        ]),
        [],
      ),
      platform: "darwin",
      repository: "owner/repo",
    });

    await expect(operations.install("0.8.0")).rejects.toThrow("UPGRADE_INSTALL_FAILED");
    expect(calls.filter((call) => call.startsWith("move:"))).toHaveLength(2);
    expect(calls.at(-1)).toBe("rmdir:/install/.quest-upgrade-123");
  });

  test("does not downgrade when the latest release is older", async () => {
    const requested: string[] = [];
    const operations = createUpgradeOperations({
      architecture: "arm64",
      executablePath: "/install/quest",
      httpClient: httpClient(new Map([[latestUrl, response(releasePayload("0.7.9"))]]), requested),
      platform: "darwin",
      repository: "owner/repo",
    });

    await expect(operations.install("0.8.0")).resolves.toMatchObject({
      installed: false,
      latest_version: "0.7.9",
      update_available: false,
    });
    expect(requested).toEqual([latestUrl]);
  });
});
