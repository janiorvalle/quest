import { describe, expect, test } from "bun:test";

import { parseGitIdentityConfig, resolveIdentity } from "./identity";

describe("identity resolution", () => {
  test("preserves empty Git values as repository-level overrides", () => {
    expect(
      parseGitIdentityConfig(
        [
          "user.email global@example.com",
          "user.email ",
          "user.name Global Name",
          "user.name ",
        ].join("\n"),
      ),
    ).toEqual({ email: "", name: "" });
  });

  test.each([
    {
      name: "accept override wins over every lower tier",
      options: {
        configured: "config-person",
        git: { email: "git-person@example.com", name: "Git Person" },
        override: "override-person",
      },
      expected: { derived: false, identity: "override-person", warning: undefined },
    },
    {
      name: "configured identity wins over Git metadata",
      options: {
        configured: "config-person",
        git: { email: "git-person@example.com", name: "Git Person" },
      },
      expected: { derived: false, identity: "config-person", warning: undefined },
    },
    {
      name: "email local-part supplies the complete person identity",
      options: { git: { email: "janiorvalle@gmail.com", name: "Janior Valle" } },
      expected: {
        derived: true,
        identity: "janiorvalle",
        warning: "identity derived from git: janiorvalle — set [identity] in config to pin",
      },
    },
    {
      name: "slugged Git user name is the email fallback",
      options: { git: { name: "Janior Valle Jr." } },
      expected: {
        derived: true,
        identity: "janior-valle-jr",
        warning: "identity derived from git: janior-valle-jr — set [identity] in config to pin",
      },
    },
    {
      name: "missing Git metadata remains fail-closed",
      options: {},
      expected: { derived: false, identity: undefined, warning: undefined },
    },
  ])("$name", ({ options, expected }) => {
    expect(resolveIdentity(options)).toEqual(expected);
  });
});
