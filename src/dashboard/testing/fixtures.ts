/** Dashboard documents for page tests: settings, Job List pages, cards and skips. */
import type {
  Card,
  JobListMeta,
  JobListPage,
  Posting,
  Settings,
  Skip,
} from "../../contract/index.ts";

export const NOW = Date.parse("2026-11-10T15:00:00.000Z");
export const REFRESHED = "2026-11-10T14:30:00.000Z";
const DAY = 86_400_000;

/** A moment some days before NOW, as an ISO timestamp. */
export const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

export const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "high" },
    ],
    seniority: ["intern", "new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City", "Remote"] }, { locations: ["Boston"] }],
  },
  resumeVariants: [{ name: "Generalist SWE", roleTypes: [], keywords: [] }],
  dailyQueueTarget: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

let next = 0;
export function posting(overrides: Partial<Posting> = {}): Posting {
  next += 1;
  return {
    id: next.toString(16).padStart(12, "0"),
    applyUrl: `https://jobs.lever.co/acme/${String(next)}`,
    company: `Company ${String(next)}`,
    title: "Software Engineer, New Grad",
    locations: ["New York, NY"],
    locationTier: 1,
    roleType: "Software Engineer",
    level: "new_grad",
    postedOn: "2026-11-08",
    sources: [{ name: "Job Feed", list: "Simplify New Grad" }],
    score: 80,
    boosts: [],
    resumeVariant: { name: "Generalist SWE", reason: "Your only Resume Variant." },
    ...overrides,
  };
}

export function jobListDocs(
  postings: Posting[],
  meta: Partial<JobListMeta> = {},
  refreshedAt = REFRESHED,
): Record<string, object> {
  const docs: Record<string, object> = {};
  const pageCount = Math.ceil(postings.length / 200);
  for (let page = 1; page <= pageCount; page++) {
    const data: JobListPage = {
      schemaVersion: 1,
      refreshedAt,
      page,
      postings: postings.slice((page - 1) * 200, page * 200),
    };
    docs[`postings/page-${String(page)}`] = data;
  }
  const metaDoc: JobListMeta = {
    schemaVersion: 1,
    refreshedAt,
    pageCount,
    total: postings.length,
    matched: postings.length,
    sources: [{ name: "Job Feed", ok: true, postings: 6407 }],
    ...meta,
  };
  docs["postings/meta"] = metaDoc;
  return docs;
}

/** A card document for a Posting, keyed by its path. */
export function cardDoc(of: Posting, overrides: Partial<Card> = {}): Record<string, Card> {
  return {
    [`cards/${of.id}`]: {
      schemaVersion: 1,
      postingId: of.id,
      stage: "queued",
      queuedAt: REFRESHED,
      queuedBy: "refresh",
      posting: of,
      updatedAt: REFRESHED,
      ...overrides,
    },
  };
}

/** A skip document for a Posting, keyed by its path. */
export function skipDoc(of: Posting, overrides: Partial<Skip> = {}): Record<string, Skip> {
  return {
    [`skips/${of.id}`]: {
      schemaVersion: 1,
      postingId: of.id,
      reason: "wrong_location",
      skippedAt: daysAgo(1),
      posting: of,
      ...overrides,
    },
  };
}
