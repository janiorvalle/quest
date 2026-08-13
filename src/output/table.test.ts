import { describe, expect, test } from "bun:test";

import { formatHumanTable } from "./table";

describe("human table formatter", () => {
  test("aligns rows and preserves a stable empty-value marker", () => {
    expect(
      formatHumanTable({
        columns: [
          { header: "ID\n", align: "right" },
          { header: "STATUS" },
          { header: "TITLE\u001b" },
          { header: "MINE" },
        ],
        rows: [
          [3, "complete", "Schema source of truth", true],
          [10, "accepted", "Résumé ✅\nproof", false],
          [11, "open", null, false],
        ],
      }),
    ).toMatchInlineSnapshot(`
      "ID  STATUS    TITLE                   MINE
      --  --------  ----------------------  -----
       3  complete  Schema source of truth  true
      10  accepted  Résumé ✅ proof         false
      11  open      -                       false"
    `);
  });

  test("rejects rows that do not match the declared columns", () => {
    expect(() =>
      formatHumanTable({
        columns: [{ header: "ID" }, { header: "TITLE" }],
        rows: [[10]],
      }),
    ).toThrow();
  });
});
