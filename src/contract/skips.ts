import * as z from "zod/mini";
import { snapshotMatches } from "./cards.ts";
import { postingIdSchema, postingSchema, timestampSchema } from "./postings.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The skips collection holds one document per Posting the Candidate took out of their Queue,
 * stored under the Posting's id, with the reason they gave. Refresh never pre-queues a skipped
 * Posting, and Tune learns from the reasons. The Posting snapshot keeps the skip meaningful after
 * the Posting leaves the Job List.
 */
export const SKIPS_COLLECTION = "skips";

export const SKIP_REASONS = [
  "wrong_role",
  "wrong_location",
  "wrong_company",
  "too_senior",
  "other",
] as const;

const skip = z
  .strictObject({
    schemaVersion: z.literal(1),
    postingId: postingIdSchema,
    reason: z.enum(SKIP_REASONS),
    skippedAt: timestampSchema,
    posting: postingSchema,
  })
  .check(snapshotMatches("skip"));

export type SkipReason = (typeof SKIP_REASONS)[number];
export type Skip = z.output<typeof skip>;

export function validateSkip(input: unknown): Validation<Skip> {
  return validateWith(skip, input);
}

/** Validates a document in the skips collection, which must sit under its Posting's id. */
export function validateSkipDocument(docId: string, input: unknown): Validation<unknown> {
  const result = validateSkip(input);
  if (result.ok && result.value.postingId !== docId) {
    return {
      ok: false,
      issues: [
        `A skip is stored under its Posting's id: ${SKIPS_COLLECTION}/${result.value.postingId}, not ${SKIPS_COLLECTION}/${docId}.`,
      ],
    };
  }
  return result;
}
