import { queryGeneric } from "convex/server";
import { ConvexError } from "convex/values";

const ADMIN_SECRET_ENVIRONMENT_VARIABLE = "QUEST_ADMIN_SECRET";
type AdminErrorCode =
  | "QUEST_ADMIN_SECRET_UNSET"
  | "QUEST_ADMIN_SECRET_REQUIRED"
  | "QUEST_ADMIN_SECRET_INVALID";

function failAdmin(code: AdminErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

function requireConfiguredAdminSecret(): string {
  const secret = process.env[ADMIN_SECRET_ENVIRONMENT_VARIABLE];
  if (secret === undefined || secret.length === 0) {
    return failAdmin(
      "QUEST_ADMIN_SECRET_UNSET",
      "this deployment has no admin secret; pipe the value to `bunx convex env set QUEST_ADMIN_SECRET` and retry. No roster mutation was attempted.",
    );
  }
  return secret;
}

async function secretDigest(secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest);
}

export async function adminSecretsMatch(expected: string, candidate: string): Promise<boolean> {
  const [expectedDigest, candidateDigest] = await Promise.all([
    secretDigest(expected),
    secretDigest(candidate),
  ]);
  let difference = expectedDigest.length ^ candidateDigest.length;
  const length = Math.max(expectedDigest.length, candidateDigest.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expectedDigest[index] ?? 0) ^ (candidateDigest[index] ?? 0);
  }
  return difference === 0;
}

export async function assertAdminSecret(candidate: string): Promise<void> {
  if (candidate.length === 0) {
    failAdmin(
      "QUEST_ADMIN_SECRET_REQUIRED",
      "pass the secret configured as `QUEST_ADMIN_SECRET`; retry the same operation with a non-empty value. No roster mutation was attempted.",
    );
  }
  const expected = requireConfiguredAdminSecret();
  if (!(await adminSecretsMatch(expected, candidate))) {
    failAdmin(
      "QUEST_ADMIN_SECRET_INVALID",
      "the supplied secret does not match this deployment; verify the target with `bunx convex env list`, then retry through the secret-safe mutation path. No roster mutation was attempted.",
    );
  }
}

export const check = queryGeneric({
  args: {},
  handler: async () => {
    requireConfiguredAdminSecret();
    return {
      ok: true,
      environment_variable: ADMIN_SECRET_ENVIRONMENT_VARIABLE,
      message: "admin secret configured; roster mutations may proceed",
    };
  },
});
