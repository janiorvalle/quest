import { z } from "zod";

export const doctorCheckNameSchema = z.enum([
  "schema",
  "backup",
  "leases",
  "processes",
  "viewer_temp",
  "evidence",
  "capacity",
]);
export type DoctorCheckName = z.infer<typeof doctorCheckNameSchema>;

export const doctorFindingStatusSchema = z.enum(["pass", "warn", "fail"]);
export type DoctorFindingStatus = z.infer<typeof doctorFindingStatusSchema>;

export const doctorFindingSchema = z.strictObject({
  check: doctorCheckNameSchema,
  status: doctorFindingStatusSchema,
  summary: z.string().trim().min(1),
  remedy: z.string().trim().min(1).nullable(),
  details: z.json(),
});
export type DoctorFinding = z.infer<typeof doctorFindingSchema>;

export const doctorDataSchema = z.strictObject({
  healthy: z.boolean(),
  checks: z.array(doctorFindingSchema),
});
export type DoctorData = z.infer<typeof doctorDataSchema>;
