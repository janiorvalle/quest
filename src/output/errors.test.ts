import { describe, expect, spyOn, test } from "bun:test";

import {
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  renderCliError,
  writeCliError,
} from "./errors";

describe("CLI exit codes and errors", () => {
  test("keeps the public exit codes stable", () => {
    expect([EXIT_SUCCESS, EXIT_DOMAIN_ERROR, EXIT_USAGE_ERROR]).toEqual([0, 1, 2]);
  });

  test("renders domain and usage errors as parseable single lines", () => {
    expect(
      renderCliError({
        kind: "domain",
        message: "quest\u001b[2J 47\u0000 already\naccepted",
      }),
    ).toEqual({
      exitCode: 1,
      line: "quest: domain: quest [2J 47 already accepted",
    });
    expect(renderCliError({ kind: "usage", message: "missing <id>" })).toEqual({
      exitCode: 2,
      line: "quest: usage: missing <id>",
    });
    expect(() => renderCliError({ kind: "usage", message: "\u001b" })).toThrow();
  });

  test("writes only the rendered error line to stderr", () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);

    expect(writeCliError({ kind: "domain", message: "claim conflict" })).toBe(1);
    expect(error).toHaveBeenCalledWith("quest: domain: claim conflict");

    error.mockRestore();
  });
});
