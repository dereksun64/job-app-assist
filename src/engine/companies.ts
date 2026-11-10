/**
 * Company names and company boosts. By default a company is boosted when it is on the
 * Fortune 500 or when the Job Feed ranks it in one of its company tiers; the Candidate's own
 * company rules (boost, lower, block) in the settings come first.
 */
import { COMPANY_RULES, type CompanyRule, type CompanyRules } from "../contract/index.ts";
import { FORTUNE_500, FORTUNE_500_BRANDS } from "./fortune-500.ts";

/** A company name as shown, without the markers some Sources add (such as "🔥"). */
export function displayCompany(name: string): string {
  return name
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the dashboard shows when a Source gives no readable company name. */
export const UNKNOWN_COMPANY = "Unknown company";

/**
 * False for names that are really ids, such as the "F7d8749a 72d6 407c ..." the Job Feed
 * derives from some Ashby board slugs.
 */
export function companyKnown(name: string): boolean {
  return (
    !/^[0-9a-f]{8}[\s-]+[0-9a-f]{4}[\s-]+[0-9a-f]{4}/i.test(name.trim()) &&
    displayCompany(name) !== ""
  );
}

const SUFFIXES =
  /\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|companies|plc|lp|llp|group holdings|holdings)\b/g;

/** A company's identity for comparing names: lowercase words, no punctuation or legal suffixes. */
export function companyKey(name: string): string {
  return displayCompany(name)
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^the /, "")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FORTUNE_500_KEYS = new Set(FORTUNE_500.map(companyKey));
const BRAND_KEYS = new Set(Object.keys(FORTUNE_500_BRANDS).map(companyKey));

export function isFortune500(name: string): boolean {
  const key = companyKey(name);
  return FORTUNE_500_KEYS.has(key) || BRAND_KEYS.has(key);
}

const FORTUNE_500_BOOST = 0.8;
const TIER_BOOSTS: Record<string, number> = {
  "1": 1,
  "1.5": 0.85,
  "2": 0.7,
  "3": 0.5,
  "4": 0.3,
};

export interface CompanyBoost {
  /** -1 for a company the Candidate lowered, 0 for no boost, up to 1. */
  value: number;
  /** Why, in the words the dashboard shows. */
  reasons: string[];
}

export const NO_COMPANY_RULES: CompanyRules = { boost: [], lower: [], block: [] };

/** The rule the Candidate gave a company, matched by its company key. */
export function companyRuleOf(company: string, rules: CompanyRules): CompanyRule | undefined {
  const key = companyKey(company);
  if (key === "") return undefined;
  return COMPANY_RULES.find((rule) => rules[rule].some((name) => companyKey(name) === key));
}

export const BOOSTED_BY_YOU = "Boosted by you";
export const LOWERED_BY_YOU = "Lowered by you";

/**
 * A company's boost: a company the Candidate boosted ranks with the top company tiers, one they
 * lowered ranks below every company with no rule, and any other company gets the larger of the
 * Fortune 500 boost and the company tier boost. Blocked companies never reach ranking.
 */
export function companyBoost(
  company: string,
  companyTier: string,
  rules: CompanyRules = NO_COMPANY_RULES,
): CompanyBoost {
  const rule = companyRuleOf(company, rules);
  if (rule === "lower") return { value: -1, reasons: [LOWERED_BY_YOU] };
  const reasons: string[] = [];
  let value = 0;
  if (isFortune500(company)) {
    reasons.push("Fortune 500");
    value = FORTUNE_500_BOOST;
  }
  const tier = /^tier\s*([\d.]+)$/i.exec(companyTier.trim())?.[1];
  const tierBoost = tier === undefined ? undefined : TIER_BOOSTS[tier];
  if (tier !== undefined && tierBoost !== undefined) {
    reasons.push(`Company tier ${tier}`);
    value = Math.max(value, tierBoost);
  }
  if (rule === "boost") return { value: 1, reasons: [BOOSTED_BY_YOU, ...reasons] };
  return { value, reasons };
}
