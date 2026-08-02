import { z } from "zod";

export const nonEmptyTextSchema = z.string().trim().min(1);
