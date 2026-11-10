import * as z from "zod/mini";
import { validateWith, type Validation } from "./validation.ts";

/** The settings collection holds exactly one document, at `settings/main`. */
export const SETTINGS_COLLECTION = "settings";
export const SETTINGS_DOC_ID = "main";

export const SENIORITIES = ["intern", "new_grad", "junior"] as const;
export const ROLE_TYPE_PRIORITIES = ["high", "medium", "low"] as const;

const label = z
  .string()
  .check(
    z.trim(),
    z.minLength(1, "must not be blank"),
    z.maxLength(120, "must be 120 characters or fewer"),
  );

/** Case-insensitive duplicates in a list, reported once each in their first spelling. */
function duplicates(values: readonly string[]): string[] {
  const first = new Map<string, string>();
  const repeated = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    const earlier = first.get(key);
    if (earlier === undefined) first.set(key, value);
    else if (!repeated.has(key)) repeated.set(key, earlier);
  }
  return [...repeated.values()];
}

/** Adds one issue per repeated value, phrased by `message`. */
function noRepeats<T>(keys: (value: T) => string[], message: (repeated: string) => string) {
  return z.superRefine<T>((value, ctx) => {
    for (const repeated of duplicates(keys(value))) {
      ctx.addIssue({ code: "custom", message: message(repeated), input: value });
    }
  });
}

const roleType = z.strictObject({
  name: label,
  priority: z.enum(ROLE_TYPE_PRIORITIES),
});

const yearMonth = z
  .string()
  .check(
    z.regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a month written as YYYY-MM, for example 2027-01"),
  );

const startWindow = z
  .strictObject({
    earliest: z.optional(yearMonth),
    latest: z.optional(yearMonth),
  })
  .check(
    z.refine(({ earliest, latest }) => !earliest || !latest || earliest <= latest, {
      message: "the earliest start month must not be after the latest",
    }),
  );

const locationTier = z.strictObject({
  locations: z
    .array(label)
    .check(z.minLength(1, "each Location Tier needs at least one location"), z.maxLength(50)),
});

const searchProfile = z.strictObject({
  roleTypes: z.array(roleType).check(
    z.minLength(1, "list at least one role type"),
    z.maxLength(30),
    noRepeats(
      (roleTypes) => roleTypes.map((r) => r.name),
      (name) => `${name} is listed more than once`,
    ),
  ),
  seniority: z.array(z.enum(SENIORITIES)).check(
    z.minLength(1, "list at least one seniority"),
    noRepeats(
      (levels) => [...levels],
      (level) => `${level} is listed more than once`,
    ),
  ),
  startWindow,
  locationTiers: z.array(locationTier).check(
    z.minLength(1, "list at least one Location Tier"),
    z.maxLength(10),
    noRepeats(
      (tiers) => tiers.flatMap((t) => t.locations),
      (location) =>
        `${location} appears more than once; each location belongs to one Location Tier`,
    ),
  ),
});

/** The most Resume Variants a Candidate keeps: a small, fixed set, one per role type they target. */
export const MAX_RESUME_VARIANTS = 6;

/**
 * One Resume Variant as the dashboard knows it: its label and the rules Refresh uses to pick it.
 * The resume file itself stays in the Candidate folder and never enters the database.
 */
const resumeVariant = z.strictObject({
  /** The label the Candidate gave it, for example "Backend SWE/SDE". */
  name: z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(60, "must be 60 characters or fewer"),
    ),
  /** Search Profile role types this variant is written for. */
  roleTypes: z.array(label).check(z.maxLength(30)),
  /** Words or phrases that point to this variant when a Posting's title or description has them. */
  keywords: z.array(label).check(
    z.maxLength(30),
    noRepeats(
      (keywords) => keywords,
      (keyword) => `${keyword} is listed more than once`,
    ),
  ),
});

/** How the Candidate wants each company treated, on top of the default boosts. */
export const COMPANY_RULES = ["boost", "lower", "block"] as const;

const companyNames = z.array(label).check(z.maxLength(200, "list at most 200 companies"));

const companies = z
  .strictObject({
    /** Ranked as high as a top company tier. */
    boost: companyNames,
    /** Ranked below companies with no rule. */
    lower: companyNames,
    /** Left out of the Job List. */
    block: companyNames,
  })
  .check(
    noRepeats(
      (lists) => COMPANY_RULES.flatMap((rule) => lists[rule]),
      (company) => `${company} is listed more than once; each company has one rule`,
    ),
  );

/** A site's host name, such as myworkdayjobs.com; it also covers every subdomain. */
const applySite = z
  .string()
  .check(
    z.trim(),
    z.toLowerCase(),
    z.regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      "must be a site's host name, such as myworkdayjobs.com",
    ),
  );

/** The freshness weight when the Candidate has not chosen one, in percent of the score. */
export const DEFAULT_FRESHNESS_WEIGHT = 20;
export const MAX_FRESHNESS_WEIGHT = 50;

const settings = z
  .strictObject({
    schemaVersion: z.literal(1),
    searchProfile,
    /** The Candidate's Resume Variants; the first one listed is the default. */
    resumeVariants: z.array(resumeVariant).check(
      z.minLength(1, "list at least one Resume Variant"),
      z.maxLength(
        MAX_RESUME_VARIANTS,
        `keep at most ${String(MAX_RESUME_VARIANTS)} Resume Variants`,
      ),
      noRepeats(
        (variants) => variants.map((v) => v.name),
        (name) => `${name} is listed more than once`,
      ),
    ),
    dailyQueueTarget: z
      .int({ error: "must be a whole number" })
      .check(z.gte(1, "must be at least 1"), z.lte(100, "must be at most 100")),
    /** Company boosts and blocks the Candidate chose; the Fortune 500 and company tiers still count. */
    companies: z._default(companies, () => ({ boost: [], lower: [], block: [] })),
    /** Postings whose only apply URLs are on these sites are left out of the Job List. */
    blockedApplySites: z._default(
      z.array(applySite).check(
        z.maxLength(50, "list at most 50 sites"),
        noRepeats(
          (sites) => sites,
          (site) => `${site} is listed more than once`,
        ),
      ),
      () => [],
    ),
    /**
     * How much freshness counts in a Posting's score, in percent. Role type priority and company
     * boosts share the rest, five parts to three.
     */
    freshnessWeight: z._default(
      z
        .int({ error: "must be a whole number" })
        .check(
          z.gte(0, "must be at least 0"),
          z.lte(MAX_FRESHNESS_WEIGHT, `must be at most ${String(MAX_FRESHNESS_WEIGHT)}`),
        ),
      DEFAULT_FRESHNESS_WEIGHT,
    ),
    /**
     * Whether Refresh reads the Candidate's Gmail, read-only, to move board cards. Absent until
     * the Candidate chooses in Setup, which counts as off.
     */
    gmailTracking: z.optional(z.boolean()),
    updatedAt: z.iso.datetime({ error: "must be an ISO 8601 timestamp" }),
  })
  .check(
    z.superRefine((value, ctx) => {
      const known = new Set(value.searchProfile.roleTypes.map((r) => r.name.toLowerCase()));
      value.resumeVariants.forEach((variant, index) => {
        const unknown = variant.roleTypes.filter((name) => !known.has(name.toLowerCase()));
        if (unknown.length === 0) return;
        ctx.addIssue({
          code: "custom",
          path: ["resumeVariants", index, "roleTypes"],
          message: `${unknown.join(", ")} ${unknown.length === 1 ? "is not a role type" : "are not role types"} in the Search Profile`,
          input: variant.roleTypes,
        });
      });
    }),
  );

export type Seniority = (typeof SENIORITIES)[number];
export type RoleTypePriority = (typeof ROLE_TYPE_PRIORITIES)[number];
export type CompanyRule = (typeof COMPANY_RULES)[number];
export type CompanyRules = z.output<typeof companies>;
export type RoleType = z.output<typeof roleType>;
export type ResumeVariant = z.output<typeof resumeVariant>;
export type LocationTier = z.output<typeof locationTier>;
export type SearchProfile = z.output<typeof searchProfile>;
export type Settings = z.output<typeof settings>;

export function validateSettings(input: unknown): Validation<Settings> {
  return validateWith(settings, input);
}
