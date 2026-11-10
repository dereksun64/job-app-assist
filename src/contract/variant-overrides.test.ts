import { describe, expect, it } from "vitest";
import { validateDocument } from "./index.ts";
import {
  VARIANT_OVERRIDES_COLLECTION,
  validateVariantOverride,
  type VariantOverride,
} from "./variant-overrides.ts";

const override: VariantOverride = {
  schemaVersion: 1,
  variant: "Backend SWE/SDE",
  chosenAt: "2026-11-10T15:00:00.000Z",
};

describe("Resume Variant override document", () => {
  it("accepts the Candidate's choice of variant for one Posting", () => {
    expect(validateVariantOverride(override)).toEqual({ ok: true, value: override });
    expect(validateDocument(VARIANT_OVERRIDES_COLLECTION, "0123456789ab", override).ok).toBe(true);
  });

  it.each<[string, object, RegExp]>([
    ["a blank variant", { variant: " " }, /^variant: /],
    ["a time that is not a timestamp", { chosenAt: "today" }, /^chosenAt: /],
    ["an unknown schema version", { schemaVersion: 2 }, /^schemaVersion: /],
    ["the resume file", { file: "resumes/backend.pdf" }, /file/],
  ])("rejects %s", (_label, change, pattern) => {
    const result = validateVariantOverride({ ...override, ...change });
    expect(result.ok ? [] : result.issues).toEqual([expect.stringMatching(pattern)]);
  });

  it("is stored under the id of the Posting it overrides", () => {
    expect(validateDocument(VARIANT_OVERRIDES_COLLECTION, "acme-123", override)).toEqual({
      ok: false,
      issues: [
        "A Resume Variant override is stored under its Posting's id: 12 lowercase hex characters.",
      ],
    });
  });
});
