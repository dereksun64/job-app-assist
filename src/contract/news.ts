import * as z from "zod/mini";
import { SENIORITIES } from "./settings.ts";
import { postingIdSchema, timestampSchema } from "./postings.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The news collection holds one News Digest per day, stored under the day it was built
 * (`news/2026-11-10`). A second Refresh on the same day rewrites that day's digest, and past
 * days stay browsable on the News tab. Refresh builds every digest from chat (ADR 0002): the
 * hiring signals come from the Candidate's own Postings, and the rest from the Refresh skill's
 * web searches and page reads.
 */
export const NEWS_COLLECTION = "news";

/** The forums the digest reads. Blind and LinkedIn are never read (hard rule 3). */
export const FORUMS = ["r/csMajors", "r/cscareerquestions", "Hacker News"] as const;

/** What a company news item is about. */
export const COMPANY_NEWS_KINDS = [
  "layoffs",
  "hiring_freeze",
  "hiring",
  "funding",
  "acquisition",
  "other",
] as const;

/** The themes an industry story belongs to. */
export const INDUSTRY_TOPICS = ["ai", "big_tech", "entry_level_market"] as const;

export const NEWS_SECTIONS = [
  "hiringSignals",
  "forumHighlights",
  "companyNews",
  "industryNews",
] as const;

export const MIN_INDUSTRY_STORIES = 5;
export const MAX_INDUSTRY_STORIES = 8;
/** How many days of digests the dashboard keeps; Refresh removes older ones. */
export const NEWS_DAYS_KEPT = 90;
/** The most Postings a hiring signal lists; `newPostings` still counts them all. */
export const MAX_SIGNAL_POSTINGS = 3;

/**
 * Sites the digest never links to, so no item can come from them: LinkedIn and Blind belong to
 * the Candidate (hard rule 3).
 */
export const BLOCKED_NEWS_HOSTS = ["linkedin.com", "lnkd.in", "teamblind.com"] as const;

const text = (max: number) =>
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(max, `must be ${String(max)} characters or fewer`),
    );

export const isoDaySchema = z
  .string()
  .check(
    z.regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "must be a day written as YYYY-MM-DD"),
  );

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The blocked site a web address is on, if any. */
export function blockedNewsHost(url: string): string | undefined {
  const host = hostOf(url);
  if (host === undefined) return undefined;
  return BLOCKED_NEWS_HOSTS.find((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

/** Where an item came from: an http or https address on a site the digest may link to. */
const sourceUrl = z.string().check(
  z.maxLength(2000, "must be 2000 characters or fewer"),
  z.regex(/^https?:\/\/[^\s/]+\.[^\s]*$/, "must be an http or https web address"),
  z.superRefine((url, ctx) => {
    const blocked = blockedNewsHost(url);
    if (blocked !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `must not link to ${blocked}; the digest never reads LinkedIn or Blind`,
        input: url,
      });
    }
  }),
);

const signalPosting = z.strictObject({
  id: postingIdSchema,
  title: text(300),
  level: z.enum(SENIORITIES),
  postedOn: isoDaySchema,
  /** The Posting's apply URL: the signal's source. */
  applyUrl: sourceUrl,
});

/** A boosted company that opened entry-level Postings in the Candidate's Job List this week. */
const hiringSignal = z
  .strictObject({
    company: text(200),
    /** Why the company stands out, as on its Postings, for example "Fortune 500". */
    boosts: z.array(text(80)).check(z.minLength(1, "list at least one boost"), z.maxLength(10)),
    /** How many of its Postings in the Job List went up this week. */
    newPostings: z.int().check(z.gte(1, "must be at least 1")),
    /** Its newest Postings, newest first. */
    postings: z
      .array(signalPosting)
      .check(
        z.minLength(1, "list at least one Posting"),
        z.maxLength(MAX_SIGNAL_POSTINGS, `list at most ${String(MAX_SIGNAL_POSTINGS)} Postings`),
      ),
  })
  .check(
    z.superRefine((value, ctx) => {
      if (value.newPostings < value.postings.length) {
        ctx.addIssue({
          code: "custom",
          path: ["newPostings"],
          message: "cannot be fewer than the Postings listed",
          input: value.newPostings,
        });
      }
    }),
  );

const FORUM_ADDRESSES: Record<(typeof FORUMS)[number], RegExp> = {
  "r/csMajors": /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/csmajors\//i,
  "r/cscareerquestions": /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/cscareerquestions\//i,
  "Hacker News": /^https:\/\/news\.ycombinator\.com\/item\?id=\d+/,
};

const FORUM_EXAMPLES: Record<(typeof FORUMS)[number], string> = {
  "r/csMajors": "https://www.reddit.com/r/csMajors/comments/...",
  "r/cscareerquestions": "https://www.reddit.com/r/cscareerquestions/comments/...",
  "Hacker News": "https://news.ycombinator.com/item?id=...",
};

/** A discussion worth knowing about, linked to its thread on the forum itself. */
const forumHighlight = z
  .strictObject({
    forum: z.enum(FORUMS),
    title: text(300),
    /** What people are saying, in a sentence or two. */
    summary: text(400),
    /** The thread itself. */
    url: sourceUrl,
  })
  .check(
    z.superRefine((value, ctx) => {
      if (!FORUM_ADDRESSES[value.forum].test(value.url)) {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: `must be a ${value.forum} thread, like ${FORUM_EXAMPLES[value.forum]}`,
          input: value.url,
        });
      }
    }),
  );

/** News about a company in the Candidate's Queue. */
const companyNews = z.strictObject({
  company: text(200),
  kind: z.enum(COMPANY_NEWS_KINDS),
  headline: text(300),
  summary: text(400),
  url: sourceUrl,
  /** Who published it, for example "Reuters". */
  source: text(80),
  publishedOn: isoDaySchema,
});

/** A wider tech story, with why it matters to the Candidate. */
const industryStory = z.strictObject({
  topic: z.enum(INDUSTRY_TOPICS),
  headline: text(300),
  summary: text(400),
  /** One line on why it matters to the Candidate, for interviews or for their search. */
  whyItMatters: text(240),
  url: sourceUrl,
  source: text(80),
  publishedOn: isoDaySchema,
});

/** A section the digest could not fill today, and why, so the page can say so. */
const gap = z.strictObject({
  section: z.enum(NEWS_SECTIONS),
  note: text(300),
});

const digest = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** The Candidate's local day the digest was built for; also its document id. */
    day: isoDaySchema,
    builtAt: timestampSchema,
    /** Postings in the Job List that went up in the 7 days up to `day`. */
    newThisWeek: z.int().check(z.gte(0)),
    hiringSignals: z.array(hiringSignal).check(z.maxLength(15)),
    forumHighlights: z.array(forumHighlight).check(z.maxLength(12)),
    companyNews: z.array(companyNews).check(z.maxLength(30)),
    industryNews: z
      .array(industryStory)
      .check(
        z.maxLength(
          MAX_INDUSTRY_STORIES,
          `list at most ${String(MAX_INDUSTRY_STORIES)} industry stories`,
        ),
      ),
    gaps: z.array(gap).check(z.maxLength(10)),
  })
  .check(
    z.superRefine((value, ctx) => {
      const stories = value.industryNews.length;
      const explained = value.gaps.some((g) => g.section === "industryNews");
      if (stories < MIN_INDUSTRY_STORIES && !(stories === 0 && explained)) {
        ctx.addIssue({
          code: "custom",
          path: ["industryNews"],
          message: `list ${String(MIN_INDUSTRY_STORIES)} to ${String(MAX_INDUSTRY_STORIES)} industry stories, or none with a gap that says why`,
          input: value.industryNews,
        });
      }
      const seen = new Set<string>();
      const items = [
        ...value.forumHighlights.map((item, i) => ({
          url: item.url,
          path: ["forumHighlights", i],
        })),
        ...value.companyNews.map((item, i) => ({ url: item.url, path: ["companyNews", i] })),
        ...value.industryNews.map((item, i) => ({ url: item.url, path: ["industryNews", i] })),
      ];
      for (const { url, path } of items) {
        if (seen.has(url)) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "url"],
            message: "links a source another item already links",
            input: url,
          });
        }
        seen.add(url);
      }
    }),
  );

export type Forum = (typeof FORUMS)[number];
export type CompanyNewsKind = (typeof COMPANY_NEWS_KINDS)[number];
export type IndustryTopic = (typeof INDUSTRY_TOPICS)[number];
export type NewsSection = (typeof NEWS_SECTIONS)[number];
export type HiringSignal = z.output<typeof hiringSignal>;
export type ForumHighlight = z.output<typeof forumHighlight>;
export type CompanyNews = z.output<typeof companyNews>;
export type IndustryStory = z.output<typeof industryStory>;
export type NewsGap = z.output<typeof gap>;
export type NewsDigest = z.output<typeof digest>;

export function validateNewsDigest(input: unknown): Validation<NewsDigest> {
  return validateWith(digest, input);
}

/** Validates a document in the news collection, which must sit under its own day. */
export function validateNewsDocument(docId: string, input: unknown): Validation<unknown> {
  const result = validateNewsDigest(input);
  if (result.ok && result.value.day !== docId) {
    return {
      ok: false,
      issues: [
        `A News Digest is stored under its day: ${NEWS_COLLECTION}/${result.value.day}, not ${NEWS_COLLECTION}/${docId}.`,
      ],
    };
  }
  return result;
}
