import { describe, expect, it } from "vitest";
import { diffSettings, formatSettingsDiff } from "./settings-diff.ts";
import type { Settings } from "./settings.ts";

const before: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "high" },
      { name: "Data Scientist", priority: "medium" },
    ],
    seniority: ["intern", "new_grad"],
    startWindow: { earliest: "2027-01", latest: "2027-12" },
    locationTiers: [{ locations: ["New York City", "Remote"] }, { locations: ["Boston"] }],
  },
  resumeVariants: [{ name: "Generalist SWE", roleTypes: [], keywords: [] }],
  dailyQueueTarget: 20,
  companies: { boost: ["OpenAI"], lower: ["Lockheed Martin"], block: [] },
  blockedApplySites: [],
  freshnessWeight: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const edit = (change: (draft: Settings) => void): Settings => {
  const draft = structuredClone(before);
  change(draft);
  draft.updatedAt = "2026-11-10T00:00:00.000Z";
  return draft;
};

const lines = (after: Settings) => diffSettings(before, after).map((c) => c.text);

describe("diffSettings", () => {
  it("finds no changes when only the timestamp moved", () => {
    expect(
      diffSettings(
        before,
        edit(() => undefined),
      ),
    ).toEqual([]);
    expect(formatSettingsDiff([])).toBe("No changes.");
  });

  it("describes the daily Queue target and freshness weight", () => {
    expect(
      lines(
        edit((s) => {
          s.dailyQueueTarget = 12;
          s.freshnessWeight = 35;
        }),
      ),
    ).toEqual(["Daily Queue target: 20 → 12", "Freshness weight: 20% → 35%"]);
  });

  it("describes added, removed, re-prioritized and reordered role types", () => {
    expect(
      lines(
        edit((s) => {
          s.searchProfile.roleTypes = [
            { name: "Machine Learning Engineer", priority: "medium" },
            { name: "Software Engineer", priority: "high" },
            { name: "Product Manager (rotational program)", priority: "low" },
          ];
        }),
      ),
    ).toEqual([
      "Role types: added Product Manager (rotational program) at low priority",
      "Role types: removed Data Scientist",
      "Role types: Machine Learning Engineer from high to medium priority",
      "Role types: order is now Machine Learning Engineer, Software Engineer, Product Manager (rotational program)",
    ]);
  });

  it("does not report an order change that only comes from adding or removing", () => {
    expect(
      lines(
        edit((s) => {
          s.searchProfile.roleTypes = s.searchProfile.roleTypes.slice(0, 2);
        }),
      ),
    ).toEqual(["Role types: removed Data Scientist"]);
  });

  it("describes seniority and start window changes", () => {
    expect(
      lines(
        edit((s) => {
          s.searchProfile.seniority = ["new_grad", "junior"];
          s.searchProfile.startWindow = { earliest: "2027-06" };
        }),
      ),
    ).toEqual([
      "Seniority: intern, new grad → new grad, junior",
      "Start window: 2027-01 to 2027-12 → from 2027-06",
    ]);
  });

  it("describes locations added, removed and moved between Location Tiers", () => {
    expect(
      lines(
        edit((s) => {
          s.searchProfile.locationTiers = [
            { locations: ["New York City", "Boston"] },
            { locations: ["Seattle"] },
          ];
        }),
      ),
    ).toEqual([
      "Location Tiers: added Seattle to Tier 2",
      "Location Tiers: removed Remote from Tier 1",
      "Location Tiers: moved Boston from Tier 2 to Tier 1",
    ]);
  });

  it("describes company rules added, removed and changed", () => {
    expect(
      lines(
        edit((s) => {
          s.companies = {
            boost: ["OpenAI", "Anthropic"],
            lower: [],
            block: ["Lockheed Martin", "Northrop Grumman"],
          };
        }),
      ),
    ).toEqual([
      "Companies: boost Anthropic",
      "Companies: block Northrop Grumman",
      "Companies: Lockheed Martin from lower to block",
    ]);
    expect(
      lines(
        edit((s) => {
          s.companies.boost = [];
        }),
      ),
    ).toEqual(["Companies: no rule for OpenAI (was boost)"]);
  });

  it("describes blocked apply sites", () => {
    const after = edit((s) => {
      s.blockedApplySites = ["myworkdayjobs.com"];
    });
    expect(lines(after)).toEqual(["Blocked apply sites: added myworkdayjobs.com"]);
    expect(diffSettings(after, before).map((c) => c.text)).toEqual([
      "Blocked apply sites: removed myworkdayjobs.com",
    ]);
  });

  it("describes Resume Variants added, removed, changed and reordered", () => {
    const withTwo = edit((s) => {
      s.resumeVariants = [
        { name: "Generalist SWE", roleTypes: [], keywords: [] },
        { name: "AI/ML Engineer", roleTypes: ["Machine Learning Engineer"], keywords: ["LLM"] },
      ];
    });
    expect(lines(withTwo)).toEqual(["Resume Variants: added AI/ML Engineer"]);
    expect(
      diffSettings(
        withTwo,
        edit((s) => {
          s.resumeVariants = [
            { name: "AI/ML Engineer", roleTypes: [], keywords: ["LLM"] },
            { name: "Generalist SWE", roleTypes: [], keywords: [] },
          ];
        }),
      ).map((c) => c.text),
    ).toEqual([
      "Resume Variants: AI/ML Engineer now picked by different rules",
      "Resume Variants: order is now AI/ML Engineer, Generalist SWE (the first is the default)",
    ]);
    expect(diffSettings(withTwo, before).map((c) => c.text)).toEqual([
      "Resume Variants: removed AI/ML Engineer",
    ]);
  });

  it("names a change to Gmail tracking", () => {
    expect(lines(edit((s) => (s.gmailTracking = true)))).toEqual([
      "Gmail tracking: not chosen → on",
    ]);
    expect(
      diffSettings({ ...before, gmailTracking: true }, { ...before, gmailTracking: false }),
    ).toEqual([{ section: "gmail", text: "Gmail tracking: on → off" }]);
  });

  it("names any other field that changed", () => {
    const after = { ...edit(() => undefined), futureField: true } as Settings;
    expect(lines(after)).toEqual(["futureField changed"]);
  });

  it("formats changes as a list with the section each belongs to", () => {
    const changes = diffSettings(
      before,
      edit((s) => {
        s.dailyQueueTarget = 10;
        s.companies.block = ["Palantir"];
      }),
    );
    expect(changes.map((c) => c.section)).toEqual(["queue", "companies"]);
    expect(formatSettingsDiff(changes)).toBe(
      "- Daily Queue target: 20 → 10\n- Companies: block Palantir",
    );
  });
});
