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
    ...overrides,
  };
}
