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
  const seen = new Set<string>();
  const repeated = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key) && !repeated.has(key)) repeated.set(key, value);
    seen.add(key);
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

const settings = z.strictObject({
  schemaVersion: z.literal(1),
  searchProfile,
  dailyQueueTarget: z
    .int({ error: "must be a whole number" })
    .check(z.gte(1, "must be at least 1"), z.lte(100, "must be at most 100")),
  updatedAt: z.iso.datetime({ error: "must be an ISO 8601 timestamp" }),
});

export type Seniority = (typeof SENIORITIES)[number];
export type RoleTypePriority = (typeof ROLE_TYPE_PRIORITIES)[number];
export type RoleType = z.output<typeof roleType>;
export type LocationTier = z.output<typeof locationTier>;
export type SearchProfile = z.output<typeof searchProfile>;
export type Settings = z.output<typeof settings>;

export function validateSettings(input: unknown): Validation<Settings> {
  return validateWith(settings, input);
}
