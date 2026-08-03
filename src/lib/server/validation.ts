import { z } from "zod";
import { ValidationError } from "./http";

const finiteNumber = z.number().finite();

export const createSongSchema = z.object({
  title: z.string().trim().min(1).max(200),
  composer: z.string().trim().max(200).default(""),
  targetTempo: finiteNumber.min(20).max(300).nullable().optional(),
  targetDate: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export const updateSongSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  composer: z.string().trim().max(200).optional(),
  targetTempo: finiteNumber.min(20).max(300).nullable().optional(),
  targetDate: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "at least one field is required",
});

export const createTakeSchema = z.object({
  label: z.string().trim().min(1).max(200).default("無題のテイク"),
  recordedAt: z.string().datetime({ offset: true }).optional(),
  durationSec: finiteNumber.min(5).max(900),
  requestedMeasureRange: z.array(z.number().int().positive()).length(2),
  requestedTempo: finiteNumber.min(20).max(300).nullable().optional(),
  inputKind: z.enum(["audio", "midi"]).default("audio"),
  contentType: z.string().max(128).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.requestedMeasureRange[0] > value.requestedMeasureRange[1]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requestedMeasureRange"], message: "start must not exceed end" });
  }
});

export const takePatchSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  memo: z.string().max(5000).optional(),
}).strict();

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request");
  }
  return parsed.data;
}

export function assertResourceId(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new ValidationError(`${name} is invalid`);
}
