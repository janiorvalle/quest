import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlatform } from "../platform";
import { type Sha256, sha256Schema } from "../schema";
import { type BlobStoreFactory, defineBlobStoreContract } from "./contract";
import { LocalBlobStore } from "./local-blob-store";

class FailableLocalBlobStore extends LocalBlobStore {
  #failNextPublish = false;
  #failNextCleanup = false;

  failNextPublish(): void {
    this.#failNextPublish = true;
  }

  failNextCleanup(): void {
    this.#failNextCleanup = true;
  }

  protected override publishTemporaryBlob(temporary: string, destination: string): Promise<void> {
    if (this.#failNextPublish) {
      this.#failNextPublish = false;
      return Promise.reject(new Error("injected publication failure"));
    }
    return super.publishTemporaryBlob(temporary, destination);
  }

  protected override removeTemporaryBlob(filePath: string): Promise<void> {
    if (this.#failNextCleanup) {
      this.#failNextCleanup = false;
      return Promise.reject(new Error("injected temporary cleanup failure"));
    }
    return super.removeTemporaryBlob(filePath);
  }
}

const localBlobStoreFactory: BlobStoreFactory = async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "quest-blob-contract-"));
  const store = new FailableLocalBlobStore(evidenceDirectory);

  return {
    store,
    failNextPublish: async () => store.failNextPublish(),
    close: () => rm(evidenceDirectory, { force: true, recursive: true }),
  };
};

defineBlobStoreContract("LocalBlobStore contract", localBlobStoreFactory);

async function withTemporaryStore(
  run: (store: LocalBlobStore, evidenceDirectory: string) => Promise<void>,
): Promise<void> {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "quest-blob-test-"));
  try {
    await run(new LocalBlobStore(evidenceDirectory), evidenceDirectory);
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
}

test("stores one lowercase extensionless file in the platform evidence directory", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "quest-blob-home-"));
  try {
    const platform = createPlatform({ environment: {}, homeDirectory });
    const store = new LocalBlobStore(platform.directories.evidence);
    const bytes = new TextEncoder().encode("viewer evidence");

    const sha256 = await store.put(bytes);

    expect(sha256).toBe(sha256.toLowerCase());
    expect(sha256Schema.safeParse(sha256).success).toBe(true);
    expect(await readdir(platform.directories.evidence)).toEqual([sha256]);
    expect(await store.get(sha256)).toEqual(bytes);
  } finally {
    await rm(homeDirectory, { force: true, recursive: true });
  }
});

test("deduplicates concurrent identical bytes independently of filename casing", async () => {
  await withTemporaryStore(async (store, evidenceDirectory) => {
    const bytes = new TextEncoder().encode("same content, different evidence metadata");
    const originalFilenames = ["Proof.PNG", "proof.png", "PROOF.Png"];

    const evidence = await Promise.all(
      originalFilenames.map(async (filename) => ({
        filename,
        sha256: await store.put(bytes),
      })),
    );
    const addresses = evidence.map(({ sha256 }) => sha256);
    const address = addresses[0];
    if (address === undefined) {
      throw new Error("expected at least one content address");
    }

    expect(evidence.map(({ filename }) => filename)).toEqual(originalFilenames);
    expect(new Set(addresses).size).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([address]);
  });
});

test("repairs a corrupt destination with concurrent publishers", async () => {
  await withTemporaryStore(async (store, evidenceDirectory) => {
    const bytes = new TextEncoder().encode("replacement content");
    const sha256 = await store.put(bytes);
    await Bun.write(join(evidenceDirectory, sha256), "corrupt content");

    await Promise.all(Array.from({ length: 8 }, () => store.put(bytes)));

    expect(await store.get(sha256)).toEqual(bytes);
    const quarantines = (await readdir(evidenceDirectory)).filter((name) =>
      name.startsWith(`${sha256}.corrupt-`),
    );
    for (const quarantine of quarantines) {
      expect(await readFile(join(evidenceDirectory, quarantine), "utf8")).toBe("corrupt content");
    }
  });
});

test("snapshots caller-owned bytes before asynchronous publication", async () => {
  await withTemporaryStore(async (store) => {
    const bytes = new TextEncoder().encode("immutable content address");
    const expected = Uint8Array.from(bytes);

    const publication = store.put(bytes);
    bytes.fill(0);
    const sha256 = await publication;

    expect(await store.get(sha256)).toEqual(expected);
  });
});

test("cleans temporary files after a failed atomic publication", async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "quest-blob-failure-"));
  try {
    const store = new FailableLocalBlobStore(evidenceDirectory);
    const bytes = new TextEncoder().encode("publication cleanup");
    store.failNextPublish();

    await expect(store.put(bytes)).rejects.toThrow("injected publication failure");
    expect(await readdir(evidenceDirectory)).toEqual([]);

    const sha256 = await store.put(bytes);
    expect(await readdir(evidenceDirectory)).toEqual([sha256]);
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
});

test("cleans quarantine links after a failed corrupt replacement", async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "quest-blob-quarantine-failure-"));
  try {
    const store = new FailableLocalBlobStore(evidenceDirectory);
    const bytes = new TextEncoder().encode("corrupt replacement");
    const sha256 = await store.put(bytes);
    await Bun.write(join(evidenceDirectory, sha256), "corrupt content");
    store.failNextPublish();

    await expect(store.put(bytes)).rejects.toThrow("injected publication failure");
    expect(
      (await readdir(evidenceDirectory)).some((name) => name.startsWith(`${sha256}.corrupt-`)),
    ).toBeFalse();
    expect(await readFile(join(evidenceDirectory, sha256), "utf8")).toBe("corrupt content");
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
});

test("keeps a published blob when temporary cleanup fails", async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "quest-blob-published-"));
  try {
    const store = new FailableLocalBlobStore(evidenceDirectory);
    const bytes = new TextEncoder().encode("published before cleanup");
    store.failNextCleanup();

    const sha256 = await store.put(bytes);

    expect(await store.get(sha256)).toEqual(bytes);
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
});

test("returns null and false for an absent lowercase address", async () => {
  await withTemporaryStore(async (store) => {
    const missing: Sha256 = "0".repeat(64);

    expect(await store.has(missing)).toBe(false);
    expect(await store.get(missing)).toBeNull();
  });
});

test("rejects relative evidence directories", () => {
  expect(() => new LocalBlobStore("relative/evidence")).toThrow(
    "evidence directory must be absolute",
  );
});
