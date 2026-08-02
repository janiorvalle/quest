import type { JSONType, z } from "zod";

import { type QuestReport, questReportSchema, questReportSchemaFor } from "../schema";

type QuestReportInput<DataSchema extends z.ZodType<JSONType>> = Omit<
  z.input<ReturnType<typeof questReportSchemaFor<DataSchema>>>,
  "schema"
>;

export function buildQuestReport<DataSchema extends z.ZodType<JSONType>>(
  dataSchema: DataSchema,
  input: QuestReportInput<DataSchema>,
) {
  return questReportSchemaFor(dataSchema).parse({
    schema: "quest.report/v1",
    ...input,
  });
}

export function formatQuestReport(report: QuestReport): string {
  return `${JSON.stringify(questReportSchema.parse(report))}\n`;
}
