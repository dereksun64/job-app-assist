import { describe, expect, it } from "vitest";
import { validateDocument } from "./index.ts";
import {
  JOB_LIST_META_ID,
  MAX_JOB_LIST_PAGES,
  POSTINGS_PER_PAGE,
  jobListPageId,
  validateJobListMeta,
  validateJobListPage,
  type JobListMeta,
  type JobListPage,
  type Posting,
} from "./postings.ts";

const refreshedAt = "2026-11-10T15:00:00.000Z";

function posting(overrides: Partial<Posting> = {}): Posting {
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
    ...overrides,
  };
}

function meta(overrides: Partial<JobListMeta> = {}): JobListMeta {
  return {
    schemaVersion: 1,
    refreshedAt,
    pageCount: 1,
    total: 1,
    matched: 1,
    sources: [{ name: "Job Feed", ok: true, postings: 6407 }],
    ...overrides,
  };
}

function page(overrides: Partial<JobListPage> = {}): JobListPage {
  return { schemaVersion: 1, refreshedAt, page: 1, postings: [posting()], ...overrides };
}

function issuesOf(result: { ok: boolean; issues?: string[] }): string[] {
  if (result.ok) throw new Error("expected the document to be rejected");
  return result.issues ?? [];
}

describe("Job List page document", () => {
  it("accepts a page of Postings", () => {
    expect(validateJobListPage(page())).toEqual({ ok: true, value: page() });
  });

  it("accepts a Posting found by several Sources and a Source without lists", () => {
    const sources = [{ name: "Job Feed", list: "Vansh New Grad" }, { name: "Watchlist" }];
    expect(validateJobListPage(page({ postings: [posting({ sources })] })).ok).toBe(true);
  });

  it("holds at most one page worth of Postings", () => {
    const postings = Array.from({ length: POSTINGS_PER_PAGE + 1 }, (_, i) =>
      posting({ id: i.toString(16).padStart(12, "0") }),
    );
    expect(issuesOf(validateJobListPage(page({ postings })))).toEqual([
      expect.stringMatching(/^postings: /),
    ]);
  });

  it("rejects the same Posting twice on a page", () => {
    expect(issuesOf(validateJobListPage(page({ postings: [posting(), posting()] })))).toEqual([
      expect.stringContaining("0123456789ab"),
    ]);
  });

  it.each<[string, Partial<Posting>, RegExp]>([
    ["an id that is not a short hash", { id: "acme-123" }, /^postings\.0\.id: /],
    ["an apply URL that is not a web address", { applyUrl: "mailto:jobs@acme.com" }, /applyUrl/],
    ["a blank company", { company: " " }, /^postings\.0\.company: /],
    ["no locations", { locations: [] }, /^postings\.0\.locations: /],
    ["a Location Tier of 0", { locationTier: 0 }, /^postings\.0\.locationTier: /],
    ["a seniority outside the Search Profile's levels", { level: "senior" as never }, /level/],
    ["a posted date that is not a day", { postedOn: "2026-11" }, /^postings\.0\.postedOn: /],
    ["no Sources", { sources: [] }, /^postings\.0\.sources: /],
    ["a score above 100", { score: 101 }, /^postings\.0\.score: /],
    ["a fractional score", { score: 50.5 }, /^postings\.0\.score: /],
  ])("rejects a Posting with %s", (_label, overrides, pattern) => {
    expect(issuesOf(validateJobListPage(page({ postings: [posting(overrides)] })))).toEqual([
      expect.stringMatching(pattern),
    ]);
  });

  it("rejects fields outside the contract, such as a description", () => {
    const withDescription = { ...posting(), description: "Long text" };
    expect(issuesOf(validateJobListPage(page({ postings: [withDescription] })))).toEqual([
      expect.stringContaining("description"),
    ]);
  });
});

describe("Job List meta document", () => {
  it("accepts a summary of the last Refresh", () => {
    expect(validateJobListMeta(meta())).toEqual({ ok: true, value: meta() });
  });

  it("accepts an empty Job List and a failing Source with its error", () => {
    const failing = meta({
      pageCount: 0,
      total: 0,
      matched: 0,
      sources: [{ name: "Job Feed", ok: false, postings: 0, error: "HTTP 503" }],
    });
    expect(validateJobListMeta(failing).ok).toBe(true);
  });

  it("rejects more matches stored than found", () => {
    expect(issuesOf(validateJobListMeta(meta({ total: 5, matched: 2 })))).toEqual([
      expect.stringMatching(/^total: /),
    ]);
  });

  it("rejects a page count that does not fit the total", () => {
    expect(issuesOf(validateJobListMeta(meta({ total: 1, pageCount: 2 })))).toEqual([
      expect.stringMatching(/^pageCount: /),
    ]);
    expect(issuesOf(validateJobListMeta(meta({ total: 201, matched: 201 })))).toEqual([
      expect.stringMatching(/^pageCount: /),
    ]);
  });

  it("rejects a Job List larger than the dashboard keeps", () => {
    const total = MAX_JOB_LIST_PAGES * POSTINGS_PER_PAGE + 1;
    expect(
      issuesOf(validateJobListMeta(meta({ total, matched: total, pageCount: 6 }))).length,
    ).toBeGreaterThan(0);
  });
});

describe("validateDocument for postings", () => {
  it("routes the meta document and each page by id", () => {
    expect(validateDocument("postings", JOB_LIST_META_ID, meta()).ok).toBe(true);
    expect(validateDocument("postings", jobListPageId(1), page()).ok).toBe(true);
  });

  it("rejects a page stored under the id of another page", () => {
    expect(validateDocument("postings", jobListPageId(2), page())).toEqual({
      ok: false,
      issues: ["page: postings/page-2 must hold page 2, not page 1."],
    });
  });

  it("rejects any other document id in the postings collection", () => {
    for (const id of ["acme-123", "page-0", `page-${String(MAX_JOB_LIST_PAGES + 1)}`]) {
      expect(validateDocument("postings", id, page()).ok).toBe(false);
    }
  });
});
