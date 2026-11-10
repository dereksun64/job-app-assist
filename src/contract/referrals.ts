import * as z from "zod/mini";
import { postingIdSchema, timestampSchema } from "./postings.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The referrals collection holds the Referral Drafts for one Posting in the Queue, stored under
 * the Posting's id: a short message per connection at the Posting's company, for the Candidate to
 * copy and send themselves. Only Refresh writes it.
 *
 * The drafts live apart from the Posting's card so that Refresh, which writes them, and the page,
 * which writes cards, never write the same document. Each draft carries only what the drawer
 * shows (the connection's name, company and position): the connections export the drafts come
 * from stays in the Candidate folder, and its email addresses and profile URLs never come here.
 */
export const REFERRALS_COLLECTION = "referrals";

/** The most connections one Posting gets a Referral Draft for. */
export const MAX_REFERRAL_DRAFTS = 3;

/** The longest Referral Draft message: a short ask, not a cover letter. */
export const REFERRAL_MESSAGE_MAX = 600;

const text = (max: number) =>
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(max, `must be ${String(max)} characters or fewer`),
    );

const draft = z.strictObject({
  /** The connection's name, as in the Candidate's connections export. */
  name: text(100),
  /** The company the connection works at, as in the connections export. */
  company: text(100),
  /** The connection's position at that company, when the export gives one. */
  position: z.optional(text(150)),
  message: text(REFERRAL_MESSAGE_MAX),
});

const referrals = z.strictObject({
  schemaVersion: z.literal(1),
  postingId: postingIdSchema,
  drafts: z.array(draft).check(
    z.minLength(1, "must hold at least one Referral Draft"),
    z.maxLength(MAX_REFERRAL_DRAFTS, `must hold at most ${String(MAX_REFERRAL_DRAFTS)}`),
    z.superRefine((drafts, ctx) => {
      const seen = new Set<string>();
      for (const { name } of drafts) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: `${name} has more than one Referral Draft`,
            input: name,
          });
        }
        seen.add(key);
      }
    }),
  ),
  updatedAt: timestampSchema,
});

export type ReferralDraft = z.output<typeof draft>;
export type Referrals = z.output<typeof referrals>;

export function validateReferrals(input: unknown): Validation<Referrals> {
  return validateWith(referrals, input);
}

/** Validates a document in the referrals collection, which must sit under its Posting's id. */
export function validateReferralsDocument(docId: string, input: unknown): Validation<Referrals> {
  const result = validateReferrals(input);
  if (result.ok && result.value.postingId !== docId) {
    return {
      ok: false,
      issues: [
        `Referral Drafts are stored under their Posting's id: ${REFERRALS_COLLECTION}/${result.value.postingId}, not ${REFERRALS_COLLECTION}/${docId}.`,
      ],
    };
  }
  return result;
}
