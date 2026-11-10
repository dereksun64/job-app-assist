/**
 * Patterns in the Candidate's skip reasons, for Tune to suggest settings changes from. Pure:
 * skips and settings in, counts and deterministic suggestions out. Tune adds the judgment this
 * module cannot make, such as noticing that many skipped companies share an industry.
 */
import {
  SKIP_REASONS,
  type RoleTypePriority,
  type Seniority,
  type Settings,
  type Skip,
  type SkipReason,
} from "../contract/index.ts";
import { applySiteOf } from "./apply-sites.ts";
import { companyKey, companyRuleOf } from "./companies.ts";

/** Skips of one kind at or above which a pattern becomes a suggestion. */
const COMPANY_THRESHOLD = 2;
const THRESHOLD = 3;
/** How many entries each list keeps, most skipped first. */
const LIST_LIMIT = 50;

export type SuggestionKind =
  | "block_company"
  | "lower_role_type"
  | "remove_role_type"
  | "reconsider_location"
  | "drop_seniority";

export interface Suggestion {
  kind: SuggestionKind;
  /** The company, role type, location or seniority the suggestion is about. */
  target: string;
  /** How many skips back it. */
  evidence: number;
  text: string;
}

export interface SkipPatterns {
  total: number;
  byReason: Record<SkipReason, number>;
  /** Every skipped company, with its skips by reason. */
  companies: { company: string; skips: number; reasons: Partial<Record<SkipReason, number>> }[];
  /** Role types skipped as the wrong role. */
  roleTypes: { roleType: string; skips: number; priority?: RoleTypePriority }[];
  /** Posting locations skipped as the wrong location. */
  locations: { location: string; locationTier: number; skips: number }[];
  /** Seniorities skipped as too senior. */
  levels: { level: Seniority; skips: number }[];
  /** Apply sites of every skipped Posting. */
  applySites: { site: string; skips: number }[];
  suggestions: Suggestion[];
}

export interface SkipPatternOptions {
  /** Only count skips made at or after this ISO timestamp. */
  since?: string;
}

const LOWER: Record<RoleTypePriority, RoleTypePriority | undefined> = {
  high: "medium",
  medium: "low",
  low: undefined,
};
const LEVEL_WORDS: Record<Seniority, string> = {
  intern: "intern",
  new_grad: "new grad",
  junior: "junior",
};

const times = (n: number) => `${String(n)} ${n === 1 ? "time" : "times"}`;

/** Counts keyed by an identity, keeping the first spelling seen and its insertion order. */
class Tally<T> {
  private readonly entries = new Map<string, { value: T; count: number }>();
  add(key: string, value: T): void {
    const entry = this.entries.get(key);
    if (entry) entry.count += 1;
    else this.entries.set(key, { value, count: 1 });
  }
  sorted(): { value: T; count: number }[] {
    return [...this.entries.values()].sort((a, b) => b.count - a.count);
  }
}

export function skipPatterns(
  allSkips: readonly Skip[],
  settings: Settings,
  options: SkipPatternOptions = {},
): SkipPatterns {
  const since = options.since;
  const skips = allSkips.filter((s) => since === undefined || s.skippedAt >= since);
  const byReason = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<
    SkipReason,
    number
  >;
  const companies = new Map<string, SkipPatterns["companies"][number]>();
  const roleTypes = new Tally<string>();
  const locations = new Tally<{ location: string; locationTier: number }>();
  const levels = new Tally<Seniority>();
  const sites = new Tally<string>();

  for (const { reason, posting } of skips) {
    byReason[reason] += 1;
    const key = companyKey(posting.company) || posting.company;
    const company = companies.get(key) ?? { company: posting.company, skips: 0, reasons: {} };
    company.skips += 1;
    company.reasons[reason] = (company.reasons[reason] ?? 0) + 1;
    companies.set(key, company);
    if (reason === "wrong_role") roleTypes.add(posting.roleType.toLowerCase(), posting.roleType);
    const [location = "Unknown"] = posting.locations;
    if (reason === "wrong_location")
      locations.add(`${String(posting.locationTier)}|${location.toLowerCase()}`, {
        location,
        locationTier: posting.locationTier,
      });
    if (reason === "too_senior") levels.add(posting.level, posting.level);
    const site = applySiteOf(posting.applyUrl);
    if (site !== undefined) sites.add(site, site);
  }

  const priorityOf = (name: string) =>
    settings.searchProfile.roleTypes.find((r) => r.name.toLowerCase() === name.toLowerCase())
      ?.priority;
  const report: SkipPatterns = {
    total: skips.length,
    byReason,
    companies: [...companies.values()].sort((a, b) => b.skips - a.skips).slice(0, LIST_LIMIT),
    roleTypes: roleTypes
      .sorted()
      .slice(0, LIST_LIMIT)
      .map(({ value, count }) => {
        const priority = priorityOf(value);
        return priority === undefined
          ? { roleType: value, skips: count }
          : { roleType: value, skips: count, priority };
      }),
    locations: locations
      .sorted()
      .slice(0, LIST_LIMIT)
      .map(({ value, count }) => ({ ...value, skips: count })),
    levels: levels.sorted().map(({ value, count }) => ({ level: value, skips: count })),
    applySites: sites
      .sorted()
      .slice(0, LIST_LIMIT)
      .map(({ value, count }) => ({ site: value, skips: count })),
    suggestions: [],
  };
  report.suggestions = suggest(report, settings);
  return report;
}

function suggest(report: SkipPatterns, settings: Settings): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const { company, reasons } of report.companies) {
    const evidence = reasons.wrong_company ?? 0;
    if (evidence < COMPANY_THRESHOLD || companyRuleOf(company, settings.companies) === "block")
      continue;
    suggestions.push({
      kind: "block_company",
      target: company,
      evidence,
      text: `Block ${company}: skipped ${times(evidence)} as the wrong company.`,
    });
  }
  for (const { roleType, skips, priority } of report.roleTypes) {
    if (skips < THRESHOLD || priority === undefined) continue;
    const lower = LOWER[priority];
    suggestions.push(
      lower === undefined
        ? {
            kind: "remove_role_type",
            target: roleType,
            evidence: skips,
            text: `Remove the role type ${roleType} (low priority): skipped ${times(skips)} as the wrong role.`,
          }
        : {
            kind: "lower_role_type",
            target: roleType,
            evidence: skips,
            text: `Lower ${roleType} from ${priority} to ${lower} priority: skipped ${times(skips)} as the wrong role.`,
          },
    );
  }
  for (const { location, locationTier, skips } of report.locations) {
    if (skips < THRESHOLD) continue;
    suggestions.push({
      kind: "reconsider_location",
      target: location,
      evidence: skips,
      text: `Move or remove the Tier ${String(locationTier)} entry that matches ${location}: skipped ${times(skips)} as the wrong location.`,
    });
  }
  const { seniority } = settings.searchProfile;
  for (const { level, skips } of report.levels) {
    // The last seniority cannot go; the Search Profile needs one.
    if (skips < THRESHOLD || !seniority.includes(level) || seniority.length === 1) continue;
    suggestions.push({
      kind: "drop_seniority",
      target: level,
      evidence: skips,
      text: `Drop ${LEVEL_WORDS[level]} from your seniority: ${String(skips)} ${LEVEL_WORDS[level]} Postings skipped as too senior.`,
    });
  }
  return suggestions.sort((a, b) => b.evidence - a.evidence);
}
