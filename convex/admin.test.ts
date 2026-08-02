import { expect, test } from "bun:test";

import { adminSecretsMatch, assertAdminSecret } from "./admin";

const adminSecretEnvironmentVariable = "QUEST_ADMIN_SECRET";

test("admin secret comparison accepts the exact value", async () => {
  expect(await adminSecretsMatch("team-admin-secret", "team-admin-secret")).toBeTrue();
});

test("admin secret comparison rejects a different value", async () => {
  expect(await adminSecretsMatch("team-admin-secret", "wrong-admin-secret")).toBeFalse();
});

test("admin secret comparison rejects a prefix or suffix", async () => {
  expect(await adminSecretsMatch("team-admin-secret", "team-admin-secret-extra")).toBeFalse();
  expect(await adminSecretsMatch("team-admin-secret-extra", "team-admin-secret")).toBeFalse();
});

test("expected admin failures preserve stable Convex error codes", async () => {
  const previous = process.env[adminSecretEnvironmentVariable];
  process.env[adminSecretEnvironmentVariable] = "team-admin-secret";
  try {
    await expect(assertAdminSecret("")).rejects.toMatchObject({
      data: { code: "QUEST_ADMIN_SECRET_REQUIRED" },
    });
    await expect(assertAdminSecret("wrong-admin-secret")).rejects.toMatchObject({
      data: { code: "QUEST_ADMIN_SECRET_INVALID" },
    });
  } finally {
    if (previous === undefined) {
      delete process.env[adminSecretEnvironmentVariable];
    } else {
      process.env[adminSecretEnvironmentVariable] = previous;
    }
  }
});
