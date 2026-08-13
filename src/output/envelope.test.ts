import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { buildQuestReport, formatQuestReport } from "./envelope";

const listDataSchema = z.strictObject({
  quests: z.array(
    z.strictObject({
      id: z.int().positive(),
      title: z.string().trim().min(1),
    }),
  ),
  total: z.int().nonnegative(),
});

describe("quest.report/v1 envelope", () => {
  test("builds and serializes a schema-validated report", () => {
    const report = buildQuestReport(listDataSchema, {
      command: "list",
      generated_at: "2026-07-29T12:34:56Z",
      filters: { repo: "quest", status: "open" },
      warnings: ["quest 12 skipped: blocked by 11"],
      data: {
        quests: [{ id: 10, title: "Output layer: envelopes + tables" }],
        total: 1,
      },
    });

    expect(report).toMatchSnapshot();
    expect(formatQuestReport(report)).toMatchSnapshot();
  });

  test("rejects invalid command data before it reaches stdout", () => {
    expect(() =>
      buildQuestReport(listDataSchema, {
        command: "list",
        generated_at: "2026-07-29T12:34:56Z",
        filters: {},
        warnings: [],
        data: {
          quests: [],
          total: -1,
        },
      }),
    ).toThrow();
  });
});
