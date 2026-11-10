import { describe, expect, it } from "vitest";
import { companyBoost, companyKey, companyRuleOf, displayCompany } from "./companies.ts";

describe("company names", () => {
  it("drops the Job Feed's markers from company names", () => {
    expect(displayCompany("🔥 NVIDIA")).toBe("NVIDIA");
    expect(displayCompany("  Two Sigma ")).toBe("Two Sigma");
  });

  it("keys companies by name, ignoring case, punctuation and legal suffixes", () => {
    expect(companyKey("Acme, Inc.")).toBe(companyKey("ACME"));
    expect(companyKey("The Walt Disney Company")).toBe(companyKey("Walt Disney"));
    expect(companyKey("🔥 Google")).toBe("google");
    expect(companyKey("AT&T")).toBe(companyKey("AT T"));
  });
});

describe("companyBoost", () => {
  it("boosts Fortune 500 companies, including the brands they hire under", () => {
    expect(companyBoost("Walmart", "Unlisted")).toEqual({ value: 0.8, reasons: ["Fortune 500"] });
    expect(companyBoost("Capital One", "Unlisted").reasons).toEqual(["Fortune 500"]);
    expect(companyBoost("Amazon Web Services (AWS)", "Unlisted").reasons).toEqual(["Fortune 500"]);
  });

  it("boosts by the Job Feed's company tier", () => {
    expect(companyBoost("OpenAI", "Tier 1")).toEqual({ value: 1, reasons: ["Company tier 1"] });
    expect(companyBoost("Ramp", "Tier 1.5").value).toBe(0.85);
    expect(companyBoost("Somebody", "Tier 2").value).toBe(0.7);
    expect(companyBoost("Somebody", "Tier 3").value).toBe(0.5);
    expect(companyBoost("Somebody", "Tier 4").value).toBe(0.3);
  });

  it("takes the larger boost and gives every reason", () => {
    expect(companyBoost("🔥 Google", "Tier 1")).toEqual({
      value: 1,
      reasons: ["Fortune 500", "Company tier 1"],
    });
    expect(companyBoost("T-Mobile", "Tier 3")).toEqual({
      value: 0.8,
      reasons: ["Fortune 500", "Company tier 3"],
    });
  });

  it("gives no boost to an unlisted company", () => {
    expect(companyBoost("Matillion", "Unlisted")).toEqual({ value: 0, reasons: [] });
    expect(companyBoost("Matillion", "")).toEqual({ value: 0, reasons: [] });
  });
});

describe("the Candidate's company rules", () => {
  const rules = { boost: ["Anthropic"], lower: ["Lockheed Martin"], block: ["Palantir"] };

  it("finds a company's rule by name, ignoring case and legal suffixes", () => {
    expect(companyRuleOf("Anthropic", rules)).toBe("boost");
    expect(companyRuleOf("Lockheed Martin Corporation", rules)).toBe("lower");
    expect(companyRuleOf("🔥 palantir", rules)).toBe("block");
    expect(companyRuleOf("Acme", rules)).toBeUndefined();
  });

  it("boosts to the top and keeps the default reasons after the Candidate's", () => {
    expect(companyBoost("Anthropic", "Tier 1", rules)).toEqual({
      value: 1,
      reasons: ["Boosted by you", "Company tier 1"],
    });
  });

  it("lowers below no boost and drops the default reasons", () => {
    expect(companyBoost("Lockheed Martin", "Unlisted", rules)).toEqual({
      value: -1,
      reasons: ["Lowered by you"],
    });
  });
});
