/**
 * Engine tests on a slice of the real Job Feed, with its run-together locations, emoji
 * markers, short links, mislabeled job types and duplicate listings.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Settings } from "../contract/index.ts";
import { parseJobFeed } from "../refresh/job-feed.ts";
import { EMPTY_QUEUE } from "./queue.ts";
import { runRefresh } from "./refresh.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/job-feed-sample.json", import.meta.url), "utf8"),
) as { resolvedLinks: Record<string, string> };
const NOW = "2026-11-10T21:00:00.000Z";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "high" },
      { name: "Product Manager (new grad program)", priority: "low" },
    ],
    seniority: ["intern", "new_grad", "junior"],
    startWindow: { earliest: "2027-01", latest: "2027-12" },
    locationTiers: [
      { locations: ["San Francisco Bay Area", "New York City", "New Jersey", "Remote"] },
      { locations: ["Southern California", "Boston", "the rest of the East Coast"] },
    ],
  },
  dailyQueueTarget: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function run() {
  return runRefresh({
    now: NOW,
    settings,
    sources: [parseJobFeed(fixture, NOW)],
    current: { pages: [] },
    queue: EMPTY_QUEUE,
    resolvedLinks: fixture.resolvedLinks,
  });
}

describe("Refresh on a slice of the real Job Feed", () => {
  const { jobList, summary } = run();
  const find = (company: string, title: RegExp) =>
    jobList.filter((p) => p.company === company && title.test(p.title));

  it("keeps only matching Postings, Tier 1 first and best first within each tier", () => {
    expect(summary).toMatchObject({ total: jobList.length, byTier: [19, 6] });
    const tiers = jobList.map((p) => p.locationTier);
    expect([...tiers].sort()).toEqual(tiers);
    for (const tier of [1, 2]) {
      const scores = jobList.filter((p) => p.locationTier === tier).map((p) => p.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
    expect(jobList.slice(0, 3).map((p) => p.company)).toEqual(["Google", "Amazon", "Verizon"]);
  });

  it("merges a short-linked listing with the same job from another list", () => {
    expect(find("T-Mobile", /^Software Engineer Intern$/)).toEqual([
      expect.objectContaining({
        applyUrl:
          "https://tmobile.wd1.myworkdayjobs.com/External/job/Philadelphia-Pennsylvania/Summer-2027-T-Ads-Software-Engineering-Internship_REQ381225",
        sources: [
          { name: "Job Feed", list: "Simplify Internships" },
          { name: "Job Feed", list: "Vansh Internships" },
        ],
        locationTier: 2,
      }),
    ]);
    expect(jobList.some((p) => p.applyUrl.includes("go.vansh.nyc"))).toBe(false);
  });

  it("merges one job listed on two career sites", () => {
    expect(find("Verizon", /Full Stack/)).toHaveLength(1);
  });

  it("leaves out roles outside the Location Tiers and other roles", () => {
    expect(jobList.some((p) => p.company === "SOTI")).toBe(false);
    expect(jobList.some((p) => p.locations.some((l) => /London|Toronto/.test(l)))).toBe(false);
    expect(summary.filteredOut.location).toBeGreaterThan(0);
    expect(summary.filteredOut.roleType).toBeGreaterThan(0);
  });

  it("reads a new-grad role listed as an internship as new grad", () => {
    expect(find("Shield AI", /Engineer 2 New Grad/)).toEqual([
      expect.objectContaining({ level: "new_grad", locationTier: 2 }),
    ]);
  });

  it("matches low-priority role types and ranks them below the focus roles", () => {
    const pm = jobList.filter((p) => p.roleType === "Product Manager (new grad program)");
    expect(pm.length).toBeGreaterThan(0);
    const tierOne = jobList.filter((p) => p.locationTier === 1);
    expect(tierOne.slice(-pm.length).map((p) => p.roleType)).toEqual(pm.map((p) => p.roleType));
  });

  it("produces documents that all match the dashboard contract", async () => {
    const { validateDocument } = await import("../contract/index.ts");
    for (const write of run().changeSet.set) {
      expect(validateDocument(write.collection, write.docId, write.data)).toMatchObject({
        ok: true,
      });
    }
  });
});
