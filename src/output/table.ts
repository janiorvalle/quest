import { stringWidth } from "bun";
import { z } from "zod";

import { sanitizeSingleLineText } from "./text";

const tableCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const tableColumnSchema = z.strictObject({
  header: z.string().transform(sanitizeSingleLineText).pipe(z.string().trim().min(1)),
  align: z.enum(["left", "right"]).default("left"),
});

export const humanTableSchema = z
  .strictObject({
    columns: z.array(tableColumnSchema).min(1),
    rows: z.array(z.array(tableCellSchema)),
  })
  .superRefine((table, context) => {
    table.rows.forEach((row, rowIndex) => {
      if (row.length !== table.columns.length) {
        context.addIssue({
          code: "custom",
          message: `expected ${table.columns.length} cells, received ${row.length}`,
          path: ["rows", rowIndex],
        });
      }
    });
  });
export type HumanTable = z.input<typeof humanTableSchema>;

function formatCell(cell: z.infer<typeof tableCellSchema>): string {
  if (cell === null) {
    return "-";
  }
  return sanitizeSingleLineText(String(cell));
}

function padCell(value: string, width: number, alignment: "left" | "right"): string {
  const padding = " ".repeat(width - stringWidth(value));
  return alignment === "right" ? `${padding}${value}` : `${value}${padding}`;
}

export function formatHumanTable(input: HumanTable): string {
  const table = humanTableSchema.parse(input);
  const rows = table.rows.map((row) => row.map(formatCell));
  const widths = table.columns.map((column, columnIndex) => {
    const values = rows.map((row) => row[columnIndex] ?? "");
    return Math.max(stringWidth(column.header), ...values.map((value) => stringWidth(value)));
  });

  const header = table.columns
    .map((column, index) => padCell(column.header, widths[index] ?? 0, column.align))
    .join("  ")
    .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) =>
    row
      .map((value, index) =>
        padCell(value, widths[index] ?? 0, table.columns[index]?.align ?? "left"),
      )
      .join("  ")
      .trimEnd(),
  );

  return [header, separator, ...body].join("\n");
}
