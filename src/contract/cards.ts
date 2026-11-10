import * as z from "zod/mini";
import { postingIdSchema, postingSchema, timestampSchema } from "./postings.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The cards collection holds one card per queued or previously queued Posting, stored under the
 * Posting's id. The Queue is every card in the `queued` Stage. A card keeps a snapshot of its
 * Posting, so it stays readable after the Posting leaves the Job List.
 */
export const CARDS_COLLECTION = "cards";

/** The Stages a card moves through, in board order. Filling is not a Stage. */
export const STAGES = [
  "queued",
  "ready_for_review",
  "submitted",
  "interviewing",
  "offer",
  "closed",
] as const;

/** Who put the Posting in the Queue: Refresh pre-queueing it, or the Candidate ticking it. */
export const QUEUED_BY = ["refresh", "candidate"] as const;

/** A queued Posting this many days old or more may have closed. */
export const POSSIBLY_CLOSED_DAYS = 5;

const DAY_MS = 86_400_000;

/** Whole days since a Posting was queued, never below zero. */
export function queueAgeDays(queuedAt: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(queuedAt)) / DAY_MS));
}

/** Checks that a document's Posting snapshot is the Posting it names. */
export function snapshotMatches(kind: string) {
  return z.superRefine<{ postingId: string; posting: { id: string } }>((value, ctx) => {
    if (value.posting.id !== value.postingId) {
      ctx.addIssue({
        code: "custom",
        path: ["posting", "id"],
        message: `must be the ${kind}'s postingId, ${value.postingId}`,
        input: value.posting.id,
      });
    }
  });
}

const card = z
  .strictObject({
    schemaVersion: z.literal(1),
    postingId: postingIdSchema,
    stage: z.enum(STAGES),
    queuedAt: timestampSchema,
    queuedBy: z.enum(QUEUED_BY),
    posting: postingSchema,
    updatedAt: timestampSchema,
  })
  .check(snapshotMatches("card"));

export type Stage = (typeof STAGES)[number];
export type QueuedBy = (typeof QUEUED_BY)[number];
export type Card = z.output<typeof card>;

export function validateCard(input: unknown): Validation<Card> {
  return validateWith(card, input);
}

/** Validates a document in the cards collection, which must sit under its Posting's id. */
export function validateCardDocument(docId: string, input: unknown): Validation<unknown> {
  const result = validateCard(input);
  if (result.ok && result.value.postingId !== docId) {
    return {
      ok: false,
      issues: [
        `A card is stored under its Posting's id: ${CARDS_COLLECTION}/${result.value.postingId}, not ${CARDS_COLLECTION}/${docId}.`,
      ],
    };
  }
  return result;
}
