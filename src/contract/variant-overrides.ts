import * as z from "zod/mini";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The variantOverrides collection holds the Candidate's own choice of Resume Variant for a
 * Posting, one document per Posting, stored under the Posting's id. The dashboard page writes
 * it from the detail drawer; Refresh never does, so a Candidate's choice outlives every Refresh
 * (see ADR 0003: the Candidate's choices about a Posting live outside the Job List).
 */
export const VARIANT_OVERRIDES_COLLECTION = "variantOverrides";

const override = z.strictObject({
  schemaVersion: z.literal(1),
  /** The name of the Resume Variant the Candidate chose. */
  variant: z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(60, "must be 60 characters or fewer"),
    ),
  chosenAt: z.iso.datetime({ error: "must be an ISO 8601 timestamp" }),
});

export type VariantOverride = z.output<typeof override>;

export function validateVariantOverride(input: unknown): Validation<VariantOverride> {
  return validateWith(override, input);
}

/** Validates a document in the variantOverrides collection, including its id. */
export function validateVariantOverrideDocument(
  docId: string,
  input: unknown,
): Validation<VariantOverride> {
  if (!/^[0-9a-f]{12}$/.test(docId)) {
    return {
      ok: false,
      issues: [
        "A Resume Variant override is stored under its Posting's id: 12 lowercase hex characters.",
      ],
    };
  }
  return validateVariantOverride(input);
}
