import type { NewsDigest } from "../news.ts";
import type { Posting } from "../postings.ts";

/** A valid Posting for contract tests; override any field. */
export function samplePosting(overrides: Partial<Posting> = {}): Posting {
  return {
    id: "0123456789ab",
    applyUrl: "https://job-boards.greenhouse.io/acme/jobs/123",
    company: "Acme",
    title: "Software Engineer, New Grad",
    locations: ["New York, NY"],
    locationTier: 1,
    roleType: "Software Engineer",
    level: "new_grad",
    postedOn: "2026-11-08",
    sources: [{ name: "Job Feed", list: "Simplify New Grad" }],
    score: 87,
    boosts: ["Fortune 500"],
    resumeVariant: { name: "Generalist SWE", reason: "Title reads as a software role." },
    ...overrides,
  };
}

type Item<K extends "hiringSignals" | "forumHighlights" | "companyNews" | "industryNews"> =
  NewsDigest[K][number];

/** A valid industry story; each number gives a different source. */
export function sampleStory(
  n = 1,
  overrides: Partial<Item<"industryNews">> = {},
): Item<"industryNews"> {
  return {
    topic: n % 3 === 0 ? "entry_level_market" : n % 2 === 0 ? "big_tech" : "ai",
    headline: `Story ${String(n)}`,
    summary: "What happened, in a sentence.",
    whyItMatters: "Interviewers ask about it.",
    url: `https://www.reuters.com/technology/story-${String(n)}/`,
    source: "Reuters",
    publishedOn: "2026-11-09",
    ...overrides,
  };
}

export function sampleSignal(
  overrides: Partial<Item<"hiringSignals">> = {},
): Item<"hiringSignals"> {
  return {
    company: "Acme",
    boosts: ["Fortune 500"],
    newPostings: 2,
    postings: [
      {
        id: "0123456789ab",
        title: "Software Engineer, New Grad",
        level: "new_grad",
        postedOn: "2026-11-08",
        applyUrl: "https://job-boards.greenhouse.io/acme/jobs/123",
      },
    ],
    ...overrides,
  };
}

export function sampleForumHighlight(
  overrides: Partial<Item<"forumHighlights">> = {},
): Item<"forumHighlights"> {
  return {
    forum: "r/csMajors",
    title: "New grad offers this cycle",
    summary: "People compare offer timelines.",
    url: "https://www.reddit.com/r/csMajors/comments/abc123/new_grad_offers/",
    ...overrides,
  };
}

export function sampleCompanyNews(
  overrides: Partial<Item<"companyNews">> = {},
): Item<"companyNews"> {
  return {
    company: "Acme",
    kind: "funding",
    headline: "Acme raises a Series C",
    summary: "Acme raised money to grow its platform team.",
    url: "https://techcrunch.com/2026/11/09/acme-series-c/",
    source: "TechCrunch",
    publishedOn: "2026-11-09",
    ...overrides,
  };
}

/** A valid News Digest for contract tests; override any field. */
export function sampleDigest(overrides: Partial<NewsDigest> = {}): NewsDigest {
  return {
    schemaVersion: 1,
    day: "2026-11-10",
    builtAt: "2026-11-10T15:00:00.000Z",
    newThisWeek: 42,
    hiringSignals: [sampleSignal()],
    forumHighlights: [
      sampleForumHighlight(),
      sampleForumHighlight({
        forum: "Hacker News",
        title: "Ask HN: Who is hiring? (November 2026)",
        summary: "The monthly hiring thread.",
        url: "https://news.ycombinator.com/item?id=45000000",
      }),
    ],
    companyNews: [sampleCompanyNews()],
    industryNews: [1, 2, 3, 4, 5].map((n) => sampleStory(n)),
    gaps: [],
    ...overrides,
  };
}

/** A copy of an object without one of its fields. */
export function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete copy[key];
  return copy;
}
