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
 *
 * When Fill finishes a card it records `fill`: how the form went and the fields the Candidate
 * must look at before submitting. A flag names a field, never the value in it, so a sensitive
 * answer never reaches the database. Fill uses `startFill` and `finishFill`.
 * Refresh moves cards from the Candidate's Gmail with `moveCardByEmail`, which records the email
 * behind each automatic move as Stage evidence: the company, the email's date and its subject,
 * never its body. When the Candidate drags a card back from a Stage an email put it in, the move
 * is undone; the evidence stays, marked undone, so the same email never moves the card again.
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

/**
 * How a Fill ended: the form is filled up to submit, the site needs the Candidate to sign in,
 * or Fill stopped for another reason it names in a flag (the Posting closed, the page broke).
 */
export const FILL_OUTCOMES = ["filled", "needs_sign_in", "stopped"] as const;

/** What Simplify's Autofill did on the form before Fill checked every field. */
export const SIMPLIFY_RESULTS = ["filled", "absent", "failed", "not_tried"] as const;

/**
 * Why Fill flagged a field: it was not sure of the answer, the answer is a claim about the
 * Candidate, it is a free-text question for the Candidate to write, the private file has no
 * answer for it, the resume upload needs a look, the site needs a sign-in or an account, or
 * something else stopped Fill.
 */
export const FILL_FLAG_KINDS = [
  "uncertain",
  "legal_claim",
  "free_text",
  "missing_answer",
  "resume",
  "sign_in",
  "problem",
] as const;

/** At most this many flags per card; Fill groups the rest into one flag. */
export const MAX_FILL_FLAGS = 40;

/** The Stages an email can move a card to. */
export const EMAIL_STAGES = ["submitted", "interviewing", "offer", "closed"] as const;

/** A Submitted card with no reply for this many days or more is flagged for follow-up. */
export const FOLLOW_UP_DAYS = 14;

/** The most Stage evidence a card keeps; the oldest entries go first. */
export const MAX_STAGE_EVIDENCE = 20;

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

const evidenceText = (max: number) =>
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(max, `must be ${String(max)} characters or fewer`),
    );

/**
 * The email behind one automatic move: only its company, date and subject. The contract has no
 * room for anything else from the email, so no body or excerpt can reach the database.
 */
const stageEvidence = z.strictObject({
  /** The company on the card the email was matched to. */
  company: evidenceText(200),
  /** When the email arrived. */
  receivedAt: timestampSchema,
  /** The email's subject line. */
  subject: evidenceText(300),
  /** The Stage the email moved the card to; Closed means rejected. */
  stage: z.enum(EMAIL_STAGES),
  /** When Refresh moved the card. */
  movedAt: timestampSchema,
  /** When the Candidate dragged the card back, undoing this move. */
  undoneAt: z.optional(timestampSchema),
});

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

const text = (max: number) =>
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(max, `must be ${String(max)} characters or fewer`),
    );

const fillFlag = z.strictObject({
  /** The field's label as the form shows it. */
  field: text(200),
  kind: z.enum(FILL_FLAG_KINDS),
  /** What the Candidate should check or do, in a sentence. */
  note: text(280),
});

const fillRecord = z
  .strictObject({
    /** When Fill finished with the card. */
    at: timestampSchema,
    outcome: z.enum(FILL_OUTCOMES),
    simplify: z.enum(SIMPLIFY_RESULTS),
    /** The Resume Variant Fill uploaded, when it uploaded one. */
    resumeVariant: z.optional(text(60)),
    flags: z
      .array(fillFlag)
      .check(z.maxLength(MAX_FILL_FLAGS, `keep at most ${String(MAX_FILL_FLAGS)}`)),
  })
  .check(
    z.superRefine((value, ctx) => {
      const signIn = value.flags.some((flag) => flag.kind === "sign_in");
      if (value.outcome === "needs_sign_in" && !signIn) {
        ctx.addIssue({
          code: "custom",
          path: ["flags"],
          message: "a Posting that needs a sign-in has a sign_in flag saying what to do",
          input: value.flags,
        });
      }
      if (value.outcome === "stopped" && value.flags.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["flags"],
          message: "a Fill that stopped has a flag saying why",
          input: value.flags,
        });
      }
      if (value.outcome !== "needs_sign_in" && signIn) {
        ctx.addIssue({
          code: "custom",
          path: ["flags"],
          message: "only a Posting that needs a sign-in has a sign_in flag",
          input: value.flags,
        });
      }
    }),
  );

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
    /** The emails behind automatic moves, oldest first. */
    stageEvidence: z.optional(z.array(stageEvidence).check(z.maxLength(MAX_STAGE_EVIDENCE))),
    posting: postingSchema,
    /** What the last Fill of this card did and flagged. */
    fill: z.optional(fillRecord),
    updatedAt: timestampSchema,
  })
  .check(snapshotMatches("card"), stageRules);

export type Stage = (typeof STAGES)[number];
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export type QueuedBy = (typeof QUEUED_BY)[number];
export type FillOutcome = (typeof FILL_OUTCOMES)[number];
export type SimplifyResult = (typeof SIMPLIFY_RESULTS)[number];
export type FillFlagKind = (typeof FILL_FLAG_KINDS)[number];
export type FillFlag = z.output<typeof fillFlag>;
export type FillRecord = z.output<typeof fillRecord>;
export type Card = z.output<typeof card>;
export type EmailStage = (typeof EMAIL_STAGES)[number];
export type StageEvidence = z.output<typeof stageEvidence>;
/** What a card keeps of an email: its company, date and subject. */
export type EmailFacts = Pick<StageEvidence, "company" | "receivedAt" | "subject">;

const stageOrder = (stage: Stage) => STAGES.indexOf(stage);

/** The evidence for the card's current Stage, when an email put it there and it has not moved since. */
export function currentEvidence(of: Card): StageEvidence | undefined {
  const last = of.stageEvidence?.at(-1);
  if (!last || last.undoneAt !== undefined) return undefined;
  return last.stage === of.stage && last.movedAt === of.stageChangedAt ? last : undefined;
}

/** Whether this email has already moved the card, including a move the Candidate undid. */
export function hasEmail(of: Card, email: Pick<EmailFacts, "receivedAt" | "subject">): boolean {
  const subject = email.subject.trim();
  return (of.stageEvidence ?? []).some(
    (e) => e.receivedAt === email.receivedAt && e.subject === subject,
  );
}

/** Each Stage's name as the Candidate sees it. */
export const STAGE_LABELS: Record<Stage, string> = {
  queued: "Queued",
  ready_for_review: "Ready for Review",
  submitted: "Submitted",
  interviewing: "Interviewing",
  offer: "Offer",
  closed: "Closed",
};

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
  // Moving a card back from the Stage an email put it in undoes that automatic move.
  const current = currentEvidence(from);
  if (current && from.stageEvidence && stageOrder(stage) < stageOrder(from.stage)) {
    moved.stageEvidence = from.stageEvidence.map((e) =>
      e === current ? { ...e, undoneAt: at } : e,
    );
  }
  return moved;
}

/** The card marked as filling from `at`. Fill works only on Queued cards. */
export function startFill(from: Card, at: string): Card {
  if (from.stage !== "queued") {
    throw new Error(`Fill works only on Queued cards; this one is ${STAGE_LABELS[from.stage]}.`);
  }
  return { ...from, fillingSince: at, updatedAt: at };
}

/**
 * The card once Fill is done with it: a filled Queued card moves to Ready for Review, a card
 * that needs a sign-in stays Queued, and a card the Candidate moved meanwhile keeps its Stage.
 * Either way the filling marker clears and the card records what Fill flagged.
 */
export function finishFill(from: Card, record: FillRecord): Card {
  const done: Card =
    record.outcome === "filled" && from.stage === "queued"
      ? moveCard(from, "ready_for_review", record.at)
      : { ...from, updatedAt: record.at };
  delete done.fillingSince;
  done.fill = record;
  return done;
}

/**
 * The card moved to `stage` at `at` because of an email, keeping the email's company, date and
 * subject as evidence. An email closes a card only as rejected.
 */
export function moveCardByEmail(
  from: Card,
  stage: EmailStage,
  email: EmailFacts,
  at: string,
): Card {
  const moved = moveCard(from, stage, at, stage === "closed" ? "rejected" : undefined);
  const evidence: StageEvidence = {
    company: email.company.trim(),
    receivedAt: email.receivedAt,
    subject: email.subject.trim(),
    stage,
    movedAt: at,
  };
  moved.stageEvidence = [...(from.stageEvidence ?? []), evidence].slice(-MAX_STAGE_EVIDENCE);
  return moved;
}

/** Whether a card has sat in Submitted, with no reply, long enough to follow up. */
export function needsFollowUp(of: Card, now: number): boolean {
  return of.stage === "submitted" && queueAgeDays(stageSince(of), now) >= FOLLOW_UP_DAYS;
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
