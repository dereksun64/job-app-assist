import { describe, expect, it } from "vitest";
import { validateDocument } from "./index.ts";
import { SETTINGS_DOC_ID, validateSettings, type Settings } from "./settings.ts";

function validSettings(): Settings {
  return {
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
        { locations: ["San Francisco Bay Area", "New York City", "Remote"] },
        { locations: ["Los Angeles", "Boston"] },
      ],
    },
    dailyQueueTarget: 20,
    updatedAt: "2026-11-10T15:00:00.000Z",
  };
}

function issuesFor(input: unknown): string[] {
  const result = validateSettings(input);
  if (result.ok) throw new Error("expected the settings document to be rejected");
  return result.issues;
}

describe("settings document", () => {
  it("accepts a complete settings document", () => {
    const result = validateSettings(validSettings());
    expect(result).toEqual({ ok: true, value: validSettings() });
  });

  it("accepts an open-ended start window", () => {
    const settings = validSettings();
    settings.searchProfile.startWindow = {};
    expect(validateSettings(settings).ok).toBe(true);
  });

  it("trims role type names and locations", () => {
    const settings = validSettings();
    settings.searchProfile.roleTypes = [{ name: "  Software Engineer ", priority: "high" }];
    settings.searchProfile.locationTiers = [{ locations: [" Remote "] }];
    const result = validateSettings(settings);
    if (!result.ok) throw new Error(result.issues.join("\n"));
    expect(result.value.searchProfile.roleTypes[0]?.name).toBe("Software Engineer");
    expect(result.value.searchProfile.locationTiers[0]?.locations).toEqual(["Remote"]);
  });

  it.each([
    ["a non-object", "settings"],
    ["null", null],
    ["an array", [validSettings()]],
  ])("rejects %s", (_label, input) => {
    expect(issuesFor(input).length).toBeGreaterThan(0);
  });

  it("rejects an unknown schema version", () => {
    expect(issuesFor({ ...validSettings(), schemaVersion: 2 })).toEqual([
      expect.stringMatching(/^schemaVersion: /),
    ]);
  });

  it("rejects fields outside the contract", () => {
    expect(issuesFor({ ...validSettings(), legalAddress: "1 Main St" })).toEqual([
      expect.stringContaining("legalAddress"),
    ]);
  });

  it("rejects unknown fields inside the Search Profile", () => {
    const settings = validSettings();
    Object.assign(settings.searchProfile, { salary: 100000 });
    expect(issuesFor(settings)).toEqual([expect.stringContaining("salary")]);
  });

  it("requires at least one role type", () => {
    const settings = validSettings();
    settings.searchProfile.roleTypes = [];
    expect(issuesFor(settings)).toEqual([expect.stringMatching(/^searchProfile\.roleTypes: /)]);
  });

  it("rejects a blank role type name", () => {
    const settings = validSettings();
    settings.searchProfile.roleTypes = [{ name: "   ", priority: "high" }];
    expect(issuesFor(settings)).toEqual([
      expect.stringMatching(/^searchProfile\.roleTypes\.0\.name: /),
    ]);
  });

  it("rejects an unknown role type priority", () => {
    const settings = validSettings();
    Object.assign(settings.searchProfile.roleTypes[0] ?? {}, { priority: "urgent" });
    expect(issuesFor(settings)).toEqual([
      expect.stringMatching(/^searchProfile\.roleTypes\.0\.priority: /),
    ]);
  });

  it("rejects the same role type listed twice, ignoring case", () => {
    const settings = validSettings();
    settings.searchProfile.roleTypes = [
      { name: "Software Engineer", priority: "high" },
      { name: "software engineer", priority: "low" },
    ];
    expect(issuesFor(settings)).toEqual([
      expect.stringMatching(/^searchProfile\.roleTypes: .*Software Engineer/i),
    ]);
  });

  it("rejects a seniority outside intern, new grad and junior", () => {
    const settings = validSettings();
    Object.assign(settings.searchProfile, { seniority: ["senior"] });
    expect(issuesFor(settings)).toEqual([expect.stringMatching(/^searchProfile\.seniority\.0: /)]);
  });

  it("requires at least one seniority and no repeats", () => {
    const settings = validSettings();
    settings.searchProfile.seniority = [];
    expect(issuesFor(settings)).toEqual([expect.stringMatching(/^searchProfile\.seniority: /)]);
    settings.searchProfile.seniority = ["intern", "intern"];
    expect(issuesFor(settings)).toEqual([expect.stringMatching(/^searchProfile\.seniority: /)]);
  });

  it.each(["2027", "2027-13", "2027-1", "Jan 2027"])(
    "rejects a start window month written as %s",
    (month) => {
      const settings = validSettings();
      settings.searchProfile.startWindow = { earliest: month };
      expect(issuesFor(settings)).toEqual([
        expect.stringMatching(/^searchProfile\.startWindow\.earliest: /),
      ]);
    },
  );

  it("rejects a start window that ends before it begins", () => {
    const settings = validSettings();
    settings.searchProfile.startWindow = { earliest: "2027-06", latest: "2027-01" };
    expect(issuesFor(settings)).toEqual([expect.stringMatching(/^searchProfile\.startWindow: /)]);
  });

  it("requires at least one Location Tier, each with at least one location", () => {
    const settings = validSettings();
    settings.searchProfile.locationTiers = [];
    expect(issuesFor(settings)).toEqual([expect.stringMatching(/^searchProfile\.locationTiers: /)]);
    settings.searchProfile.locationTiers = [{ locations: [] }];
    expect(issuesFor(settings)).toEqual([
      expect.stringMatching(/^searchProfile\.locationTiers\.0\.locations: /),
    ]);
  });

  it("rejects a location that appears in two Location Tiers", () => {
    const settings = validSettings();
    settings.searchProfile.locationTiers = [
      { locations: ["Remote", "Boston"] },
      { locations: ["boston"] },
    ];
    expect(issuesFor(settings)).toEqual([
      expect.stringMatching(/^searchProfile\.locationTiers: .*Boston/i),
    ]);
  });

  it.each([0, -1, 2.5, 101, "20"])("rejects a daily Queue target of %j", (target) => {
    expect(issuesFor({ ...validSettings(), dailyQueueTarget: target })).toEqual([
      expect.stringMatching(/^dailyQueueTarget: /),
    ]);
  });

  it("requires updatedAt to be an ISO timestamp", () => {
    expect(issuesFor({ ...validSettings(), updatedAt: "yesterday" })).toEqual([
      expect.stringMatching(/^updatedAt: /),
    ]);
  });

  it("reports every problem at once", () => {
    const issues = issuesFor({ ...validSettings(), dailyQueueTarget: 0, updatedAt: "" });
    expect(issues).toHaveLength(2);
  });
});

describe("validateDocument", () => {
  it("validates the settings document by collection and id", () => {
    expect(validateDocument("settings", SETTINGS_DOC_ID, validSettings()).ok).toBe(true);
  });

  it("rejects a settings document under any other id", () => {
    expect(validateDocument("settings", "other", validSettings())).toEqual({
      ok: false,
      issues: [`The settings collection holds one document, with the id "${SETTINGS_DOC_ID}".`],
    });
  });

  it("rejects an invalid settings document", () => {
    expect(validateDocument("settings", SETTINGS_DOC_ID, {}).ok).toBe(false);
  });

  it("rejects a collection outside the contract", () => {
    expect(validateDocument("passwords", "x", {})).toEqual({
      ok: false,
      issues: ['"passwords" is not a collection in the dashboard contract.'],
    });
  });
});
