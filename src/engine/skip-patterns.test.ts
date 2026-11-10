import { describe, expect, it } from "vitest";
import type { Posting, Settings, Skip, SkipReason } from "../contract/index.ts";
import { skipPatterns } from "./skip-patterns.ts";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Data Scientist", priority: "medium" },
      { name: "Product Manager", priority: "low" },
    ],
    seniority: ["new_grad", "junior"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City"] }, { locations: ["Austin"] }],
  },
  resumeVariants: [{ name: "Generalist SWE", roleTypes: [], keywords: [] }],
  dailyQueueTarget: 20,
  companies: { boost: [], lower: [], block: ["Already Blocked"] },
  blockedApplySites: [],
  freshnessWeight: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

let next = 0;
function skip(
  reason: SkipReason,
  posting: Partial<Posting> = {},
  skippedAt = "2026-11-05T00:00:00.000Z",
): Skip {
  next += 1;
  const id = next.toString(16).padStart(12, "0");
  return {
    schemaVersion: 1,
    postingId: id,
    reason,
    skippedAt,
    posting: {
      id,
      applyUrl: `https://jobs.lever.co/acme/${String(next)}`,
      company: "Acme",
      title: "Software Engineer, New Grad",
      locations: ["New York, NY"],
      locationTier: 1,
      roleType: "Software Engineer",
      level: "new_grad",
      postedOn: "2026-11-01",
      sources: [{ name: "Job Feed" }],
      score: 70,
      boosts: [],
      resumeVariant: { name: "Generalist SWE", reason: "The default Resume Variant." },
      ...posting,
    },
  };
}

describe("skipPatterns", () => {
  it("reports nothing to suggest with no skips", () => {
    expect(skipPatterns([], settings)).toEqual({
      total: 0,
      byReason: { wrong_role: 0, wrong_location: 0, wrong_company: 0, too_senior: 0, other: 0 },
      companies: [],
      roleTypes: [],
      locations: [],
      levels: [],
      applySites: [],
      suggestions: [],
    });
  });

  it("counts skips by reason, company, role type, location, level and apply site", () => {
    const report = skipPatterns(
      [
        skip("wrong_company", { company: "Lockheed Martin" }),
        skip("wrong_company", { company: "Lockheed Martin Corporation" }),
        skip("wrong_role", { roleType: "Data Scientist", company: "Lockheed Martin" }),
        skip("wrong_location", {
          locations: ["Austin, TX"],
          locationTier: 2,
          applyUrl: "https://x.wd1.myworkdayjobs.com/1",
        }),
        skip("too_senior", { level: "junior", applyUrl: "https://y.wd5.myworkdayjobs.com/2" }),
      ],
      settings,
    );
    expect(report.total).toBe(5);
    expect(report.byReason).toEqual({
      wrong_role: 1,
      wrong_location: 1,
      wrong_company: 2,
      too_senior: 1,
      other: 0,
    });
    expect(report.companies[0]).toEqual({
      company: "Lockheed Martin",
      skips: 3,
      reasons: { wrong_company: 2, wrong_role: 1 },
    });
    expect(report.roleTypes).toEqual([
      { roleType: "Data Scientist", skips: 1, priority: "medium" },
    ]);
    expect(report.locations).toEqual([{ location: "Austin, TX", locationTier: 2, skips: 1 }]);
    expect(report.levels).toEqual([{ level: "junior", skips: 1 }]);
    expect(report.applySites).toEqual([
      { site: "lever.co", skips: 3 },
      { site: "myworkdayjobs.com", skips: 2 },
    ]);
  });

  it("suggests blocking a company skipped as the wrong company twice", () => {
    const report = skipPatterns(
      [
        skip("wrong_company", { company: "Raytheon" }),
        skip("wrong_company", { company: "raytheon" }),
        skip("wrong_company", { company: "Already Blocked" }),
        skip("wrong_company", { company: "Already Blocked" }),
        skip("wrong_company", { company: "Once" }),
      ],
      settings,
    );
    expect(report.suggestions).toEqual([
      {
        kind: "block_company",
        target: "Raytheon",
        evidence: 2,
        text: "Block Raytheon: skipped 2 times as the wrong company.",
      },
    ]);
  });

  it("suggests lowering a role type skipped as the wrong role three times, and removing a low one", () => {
    const report = skipPatterns(
      [
        ...[1, 2, 3].map(() => skip("wrong_role", { roleType: "Data Scientist" })),
        ...[1, 2, 3, 4].map(() => skip("wrong_role", { roleType: "Product Manager" })),
        ...[1, 2].map(() => skip("wrong_role", { roleType: "Software Engineer" })),
      ],
      settings,
    );
    expect(report.suggestions).toEqual([
      {
        kind: "remove_role_type",
        target: "Product Manager",
        evidence: 4,
        text: "Remove the role type Product Manager (low priority): skipped 4 times as the wrong role.",
      },
      {
        kind: "lower_role_type",
        target: "Data Scientist",
        evidence: 3,
        text: "Lower Data Scientist from medium to low priority: skipped 3 times as the wrong role.",
      },
    ]);
  });

  it("suggests reconsidering a location skipped as the wrong location three times", () => {
    const report = skipPatterns(
      [1, 2, 3].map(() => skip("wrong_location", { locations: ["Austin, TX"], locationTier: 2 })),
      settings,
    );
    expect(report.suggestions).toEqual([
      {
        kind: "reconsider_location",
        target: "Austin, TX",
        evidence: 3,
        text: "Move or remove the Tier 2 entry that matches Austin, TX: skipped 3 times as the wrong location.",
      },
    ]);
  });

  it("suggests dropping a seniority whose Postings are skipped as too senior three times", () => {
    const report = skipPatterns(
      [1, 2, 3].map(() => skip("too_senior", { level: "junior" })),
      settings,
    );
    expect(report.suggestions).toEqual([
      {
        kind: "drop_seniority",
        target: "junior",
        evidence: 3,
        text: "Drop junior from your seniority: 3 junior Postings skipped as too senior.",
      },
    ]);
  });

  it("leaves out skips older than the window it is given", () => {
    const report = skipPatterns(
      [
        skip("wrong_company", { company: "Old" }, "2026-01-01T00:00:00.000Z"),
        skip("wrong_company", { company: "Old" }, "2026-01-02T00:00:00.000Z"),
      ],
      settings,
      { since: "2026-06-01T00:00:00.000Z" },
    );
    expect(report.total).toBe(0);
    expect(report.suggestions).toEqual([]);
  });
});
