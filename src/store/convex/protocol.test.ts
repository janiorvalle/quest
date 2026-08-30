import { expect, test } from "bun:test";

import {
  clientProtocolInput,
  compareQuestVersions,
  isQuestVersionAtLeast,
  MINIMUM_QUEST_CLIENT_PROTOCOL,
  QUEST_CLIENT_PROTOCOL,
} from "./protocol";

test("bumps the member protocol and sends the release version together", () => {
  expect(QUEST_CLIENT_PROTOCOL).toBe(5);
  expect(MINIMUM_QUEST_CLIENT_PROTOCOL).toBe(5);
  expect(clientProtocolInput()).toMatchObject({
    client_protocol: QUEST_CLIENT_PROTOCOL,
    client_version: expect.any(String),
  });
});

test("compares semantic versions including prerelease precedence", () => {
  expect(compareQuestVersions("1.2.3", "1.2.3-rc.9")).toBe(1);
  expect(compareQuestVersions("1.2.3-rc.10", "1.2.3-rc.9")).toBe(1);
  expect(compareQuestVersions("1.2.3-beta.1", "1.2.3-beta.2")).toBe(-1);
  expect(compareQuestVersions("1.2.3+build.1", "1.2.3+build.2")).toBe(0);
});

test("rejects malformed versions instead of guessing an ordering", () => {
  expect(compareQuestVersions("1.2", "1.2.0")).toBeUndefined();
  expect(compareQuestVersions("1.2.3-01", "1.2.3-1")).toBeUndefined();
  expect(isQuestVersionAtLeast("1.2", "1.2.0")).toBeFalse();
});
