import * as z from "zod/mini";
import { SENIORITIES } from "./settings.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The postings collection holds the Job List, and only the Job List (never the full Job Feed).
 * Refresh owns it and rewrites it whole on every run: one `meta` document describing the run,
 * and the ranked Postings split across `page-1` to `page-N` in rank order (see ADR 0003).
 * The page shows a Job List only when every page carries the meta document's `refreshedAt`.
 */
export const POSTINGS_COLLECTION = "postings";
/** The name the shared Job Feed goes by as a Source. */
export const JOB_FEED_SOURCE = "Job Feed";
export const JOB_LIST_META_ID = "meta";
export const POSTINGS_PER_PAGE = 200;
export const MAX_JOB_LIST_PAGES = 5;
/** The most Postings a Job List keeps; Refresh keeps the best-ranked ones past this. */
export const MAX_JOB_LIST = POSTINGS_PER_PAGE * MAX_JOB_LIST_PAGES;

/** The longest description excerpt a Posting carries; the full text stays on the Posting's site. */
export const POSTING_DESCRIPTION_MAX = 400;

export function jobListPageId(page: number): string {
  return `page-${String(page)}`;
}

const text = (max: number) =>
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(max, `must be ${String(max)} characters or fewer`),
    );

const webAddress = z
  .string()
  .check(
    z.maxLength(2000, "must be 2000 characters or fewer"),
    z.regex(/^https?:\/\/[^\s/]+\.[^\s]*$/, "must be an http or https web address"),
  );

const isoDay = z
  .string()
  .check(
    z.regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "must be a day written as YYYY-MM-DD"),
  );

export const timestampSchema = z.iso.datetime({ error: "must be an ISO 8601 timestamp" });

/** A Posting's id: a short hash of its canonical apply URL, stable across Refreshes. */
export const postingIdSchema = z
  .string()
  .check(z.regex(/^[0-9a-f]{12}$/, "must be 12 lowercase hex characters"));

const postingSource = z.strictObject({
  /** The Source, for example "Job Feed". */
  name: text(80),
  /** Where inside the Source the Posting was listed, for example "Simplify New Grad". */
  list: z.optional(text(120)),
});

const resumeVariantPick = z.strictObject({
  /** The name of one of the Candidate's Resume Variants. */
  name: text(60),
  /** Why it was picked, in plain words, for example "Title mentions \"backend\"." */
  reason: text(300),
});

/** One Posting; cards and skips keep a snapshot of the Posting they refer to. */
export const postingSchema = z.strictObject({
  /** A short hash of the Posting's canonical apply URL; stable across Refreshes. */
  id: postingIdSchema,
  /** Where the Candidate applies, with short links already resolved when they could be. */
  applyUrl: webAddress,
  company: text(200),
  title: text(300),
  locations: z
    .array(text(200))
    .check(z.minLength(1, "list at least one location"), z.maxLength(60)),
  /** The best Location Tier among the Posting's locations, counting from 1. */
  locationTier: z.int().check(z.gte(1, "must be at least 1"), z.lte(10, "must be at most 10")),
  /** The Search Profile role type the Posting matched. */
  roleType: text(120),
  level: z.enum(SENIORITIES),
  postedOn: isoDay,
  sources: z
    .array(postingSource)
    .check(z.minLength(1, "list at least one Source"), z.maxLength(20)),
  /** Rank within its Location Tier, 0 to 100, from fit, company boosts and freshness. */
  score: z
    .int({ error: "must be a whole number" })
    .check(z.gte(0, "must be at least 0"), z.lte(100, "must be at most 100")),
  /** Why the company was boosted, for example "Fortune 500". */
  boosts: z.array(text(80)).check(z.maxLength(10)),
  /** The Resume Variant Refresh picked for this Posting, and why. */
  resumeVariant: resumeVariantPick,
  /** The start of the Posting's description, when its Source gives one. */
  description: z.optional(text(POSTING_DESCRIPTION_MAX)),
});

const page = z.strictObject({
  schemaVersion: z.literal(1),
  /** The Refresh that wrote this page; it matches the meta document's `refreshedAt`. */
  refreshedAt: timestampSchema,
  page: z.int().check(z.gte(1), z.lte(MAX_JOB_LIST_PAGES)),
  postings: z.array(postingSchema).check(
    z.maxLength(POSTINGS_PER_PAGE, `a page holds at most ${String(POSTINGS_PER_PAGE)} Postings`),
    z.superRefine((postings, ctx) => {
      const seen = new Set<string>();
      for (const { id } of postings) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `Posting ${id} appears more than once`,
            input: id,
          });
        }
        seen.add(id);
      }
    }),
  ),
});

const sourceReport = z.strictObject({
  name: text(80),
  /** The part of the Source this report covers, for example one watchlist company. */
  list: z.optional(text(200)),
  ok: z.boolean(),
  /** How many Postings the Source listed, before the Search Profile filtered them. */
  postings: z.int().check(z.gte(0)),
  /** What went wrong, in plain words, when `ok` is false. */
  error: z.optional(text(500)),
});

const meta = z
  .strictObject({
    schemaVersion: z.literal(1),
    refreshedAt: timestampSchema,
    pageCount: z.int().check(z.gte(0), z.lte(MAX_JOB_LIST_PAGES)),
    /** Postings stored in the Job List. */
    total: z.int().check(z.gte(0), z.lte(MAX_JOB_LIST)),
    /** Postings that matched the Search Profile, before the Job List kept the best `total`. */
    matched: z.int().check(z.gte(0)),
    /** One report per Source read; the watchlist reports each company on its own. */
    sources: z.array(sourceReport).check(z.maxLength(250)),
  })
  .check(
    z.superRefine((value, ctx) => {
      if (value.total > value.matched) {
        ctx.addIssue({
          code: "custom",
          path: ["total"],
          message: "cannot be more than the Postings matched",
          input: value.total,
        });
      }
      const pages = Math.ceil(value.total / POSTINGS_PER_PAGE);
      if (value.pageCount !== pages) {
        ctx.addIssue({
          code: "custom",
          path: ["pageCount"],
          message: `must be ${String(pages)} for ${String(value.total)} Postings`,
          input: value.pageCount,
        });
      }
    }),
  );

export type PostingSource = z.output<typeof postingSource>;
export type ResumeVariantPick = z.output<typeof resumeVariantPick>;
export type Posting = z.output<typeof postingSchema>;
export type JobListPage = z.output<typeof page>;
export type SourceReport = z.output<typeof sourceReport>;
export type JobListMeta = z.output<typeof meta>;

export function validateJobListPage(input: unknown): Validation<JobListPage> {
  return validateWith(page, input);
}

export function validateJobListMeta(input: unknown): Validation<JobListMeta> {
  return validateWith(meta, input);
}

/** Validates any document in the postings collection by its id. */
export function validatePostingsDocument(docId: string, input: unknown): Validation<unknown> {
  if (docId === JOB_LIST_META_ID) return validateJobListMeta(input);
  const pageNumber = /^page-([1-9]\d*)$/.exec(docId)?.[1];
  if (pageNumber === undefined || Number(pageNumber) > MAX_JOB_LIST_PAGES) {
    return {
      ok: false,
      issues: [
        `The postings collection holds "${JOB_LIST_META_ID}" and "page-1" to "page-${String(MAX_JOB_LIST_PAGES)}".`,
      ],
    };
  }
  const result = validateJobListPage(input);
  if (result.ok && result.value.page !== Number(pageNumber)) {
    return {
      ok: false,
      issues: [
        `page: postings/${docId} must hold page ${pageNumber}, not page ${String(result.value.page)}.`,
      ],
    };
  }
  return result;
}
