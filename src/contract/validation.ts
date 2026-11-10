import * as z from "zod/mini";
import { en } from "zod/locales";

z.config(en());

/** The outcome of checking a document against the dashboard contract. */
export type Validation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Formats each problem as `path: message`, so a skill can show it to the Candidate as is. */
export function validateWith<T>(schema: z.ZodMiniType<T>, input: unknown): Validation<T> {
  const result = z.safeParse(schema, input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    }),
  };
}
