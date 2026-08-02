import { type JSONType, z } from "zod";

export const reportFiltersSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
);
export type ReportFilters = z.infer<typeof reportFiltersSchema>;

export const questReportSchema = z.strictObject({
  schema: z.literal("quest.report/v1"),
  command: z.string().trim().min(1),
  generated_at: z.iso.datetime({ offset: true }),
  filters: reportFiltersSchema,
  warnings: z.array(z.string()),
  data: z.json(),
});
export type QuestReport = z.infer<typeof questReportSchema>;

export function questReportSchemaFor<DataSchema extends z.ZodType<JSONType>>(
  dataSchema: DataSchema,
) {
  return questReportSchema.extend({ data: dataSchema });
}
