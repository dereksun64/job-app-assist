import { describe, expect, it } from "vitest";
import { validateDocument } from "./index.ts";
import {
  MAX_REFERRAL_DRAFTS,
  REFERRALS_COLLECTION,
  validateReferrals,
  type Referrals,
} from "./referrals.ts";

const draft = {
  name: "Priya Shah",
  company: "Datadog",
  position: "Senior Software Engineer",
  message:
    "Hi Priya, I'm applying to Datadog's new grad Software Engineer role. Would you be open to referring me?",
};

const referrals: Referrals = {
  schemaVersion: 1,
  postingId: "0123456789ab",
  drafts: [draft],
  updatedAt: "2026-11-10T15:00:00.000Z",
};

describe("Referral Drafts document", () => {
  it("accepts drafts for one queued Posting", () => {
    expect(validateReferrals(referrals)).toEqual({ ok: true, value: referrals });
    expect(validateDocument(REFERRALS_COLLECTION, "0123456789ab", referrals).ok).toBe(true);
  });

  it("accepts a connection with no position", () => {
    const { name, company, message } = draft;
    expect(validateReferrals({ ...referrals, drafts: [{ name, company, message }] }).ok).toBe(true);
  });

  it.each<[string, object, RegExp]>([
    ["no drafts", { drafts: [] }, /^drafts: /],
    [
      "too many drafts",
      {
        drafts: Array.from({ length: MAX_REFERRAL_DRAFTS + 1 }, (_, i) => ({
          ...draft,
          name: `Person ${String(i)}`,
        })),
      },
      /^drafts: /,
    ],
    ["a blank message", { drafts: [{ ...draft, message: "  " }] }, /^drafts\.0\.message: /],
    [
      "a message that is not short",
      { drafts: [{ ...draft, message: "x".repeat(601) }] },
      /^drafts\.0\.message: /,
    ],
    ["a blank connection name", { drafts: [{ ...draft, name: "" }] }, /^drafts\.0\.name: /],
    [
      "the connection's email address",
      { drafts: [{ ...draft, email: "priya@example.com" }] },
      /email/,
    ],
    [
      "the connection's profile URL",
      { drafts: [{ ...draft, url: "https://www.linkedin.com/in/priya" }] },
      /url/,
    ],
    ["the whole connections export", { connections: [draft] }, /connections/],
    ["an unknown schema version", { schemaVersion: 2 }, /^schemaVersion: /],
  ])("rejects %s", (_label, change, pattern) => {
    const result = validateReferrals({ ...referrals, ...change });
    expect(result.ok ? [] : result.issues).toEqual([expect.stringMatching(pattern)]);
  });

  it("rejects the same connection twice", () => {
    const result = validateReferrals({ ...referrals, drafts: [draft, draft] });
    expect(result.ok ? [] : result.issues).toEqual([
      "drafts: Priya Shah has more than one Referral Draft",
    ]);
  });

  it("is stored under the id of its Posting", () => {
    expect(validateDocument(REFERRALS_COLLECTION, "fedcba987654", referrals)).toEqual({
      ok: false,
      issues: [
        "Referral Drafts are stored under their Posting's id: referrals/0123456789ab, not referrals/fedcba987654.",
      ],
    });
  });
});
