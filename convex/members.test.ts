import { expect, test } from "bun:test";

import { revokeOwnerKeys, rotateMemberKey } from "./members";

test("finite-use keys are rejected before the rotator is called", async () => {
  let calls = 0;
  const promise = rotateMemberKey(
    async () => {
      calls += 1;
      return {
        newKey: "never-returned",
        newKeyId: "never-returned",
        oldKeyExpiresAt: 0,
      };
    },
    { keyId: "invite-key", remaining: 1 },
    "alice",
  );

  await expect(promise).rejects.toMatchObject({
    data: { code: "QUEST_FINITE_KEY_ROTATION_FORBIDDEN" },
  });
  expect(calls).toBe(0);
});

test("member key rotation reaches the rotator for unlimited keys", async () => {
  const result = await rotateMemberKey(
    async (input) => ({
      newKey: `new-${input.ownerId}`,
      newKeyId: input.keyId,
      oldKeyExpiresAt: 123,
    }),
    { keyId: "member-key" },
    "alice",
  );

  expect(result).toEqual({
    newKey: "new-alice",
    newKeyId: "member-key",
    oldKeyExpiresAt: 123,
  });
});

test("member removal bulk-revokes member and invite keys without pagination", async () => {
  const tags: string[] = [];
  const revoked = await revokeOwnerKeys(async ({ ownerId, tag }) => {
    expect(ownerId).toBe("alice");
    tags.push(tag);
    return { revokedCount: tag === "member" ? 101 : 1 };
  }, "alice");

  expect(tags).toEqual(["member", "invite"]);
  expect(revoked).toBe(102);
});
