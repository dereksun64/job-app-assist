import * as z from "zod/mini";
import { postingIdSchema, postingSchema, timestampSchema } from "./postings.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The cards collection holds one card per queued or previously queued Posting, stored under the
 * Posting's id. The Queue is every card in the `queued` Stage. A card keeps a snapshot of its
 * Posting, so it stays readable after the Posting leaves the Job List.
 *
 * Stage lifecycle: a card starts Queued and moves through the Stages below, in any direction
 * (the Candidate can drag a card back to undo a move). A Closed card always says why, rejected or
 * withdrawn. Filling is not a Stage: Fill marks a Queued card with `fillingSince` while it fills
 * the Posting's form, and moving the card to any Stage clears the marker. Writers change Stage
 * with `moveCard`, which keeps these rules.
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

/** Why a Closed card closed: the company said no, or the Candidate withdrew. */
export const CLOSED_REASONS = ["rejected", "withdrawn"] as const;

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

const stageRules = z.superRefine<{
  stage: Stage;
  closedReason?: ClosedReason | undefined;
  fillingSince?: string | undefined;
}>((value, ctx) => {
  if (value.stage === "closed" && value.closedReason === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["closedReason"],
      message: "a Closed card says whether the Candidate was rejected or withdrew",
      input: value.closedReason,
    });
  }
  if (value.stage !== "closed" && value.closedReason !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["closedReason"],
      message: "only a Closed card has a closedReason",
      input: value.closedReason,
    });
  }
  if (value.stage !== "queued" && value.fillingSince !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["fillingSince"],
      message: "only a Queued card can be filling",
      input: value.fillingSince,
    });
  }
});

const card = z
  .strictObject({
    schemaVersion: z.literal(1),
    postingId: postingIdSchema,
    stage: z.enum(STAGES),
    /** Present exactly when the Stage is Closed. */
    closedReason: z.optional(z.enum(CLOSED_REASONS)),
    /** The filling marker: when Fill started filling this Queued card's Posting. */
    fillingSince: z.optional(timestampSchema),
    queuedAt: timestampSchema,
    queuedBy: z.enum(QUEUED_BY),
    /** When the card entered its Stage; absent until it first moves, so `queuedAt` stands in. */
    stageChangedAt: z.optional(timestampSchema),
    posting: postingSchema,
    updatedAt: timestampSchema,
  })
  .check(snapshotMatches("card"), stageRules);

export type Stage = (typeof STAGES)[number];
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export type QueuedBy = (typeof QUEUED_BY)[number];
export type Card = z.output<typeof card>;

/**
 * The card moved to `stage` at `at` (an ISO timestamp). Closing needs a reason; moving clears
 * the filling marker and drops a reason the new Stage does not take.
 */
export function moveCard(from: Card, stage: Stage, at: string, closedReason?: ClosedReason): Card {
  if (stage === "closed" && closedReason === undefined) {
    throw new Error("A card can only close as rejected or withdrawn.");
  }
  const moved: Card = { ...from, stage, stageChangedAt: at, updatedAt: at };
  delete moved.closedReason;
  delete moved.fillingSince;
  if (stage === "closed") moved.closedReason = closedReason;
  return moved;
}

/** When the card entered its current Stage. */
export function stageSince(of: Card): string {
  return of.stageChangedAt ?? of.queuedAt;
}

/**
 * Queue order, the order Fill works through Queued cards: cards queued earlier first, then the
 * better Location Tier, then the higher score, as Refresh pre-queues them.
 */
export function compareQueueOrder(a: Card, b: Card): number {
  return (
    a.queuedAt.localeCompare(b.queuedAt) ||
    a.posting.locationTier - b.posting.locationTier ||
    b.posting.score - a.posting.score ||
    a.postingId.localeCompare(b.postingId)
  );
}

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
