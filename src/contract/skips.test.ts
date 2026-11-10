import { describe, expect, it } from "vitest";
import { validateDocument } from "./index.ts";
import { SKIPS_COLLECTION, SKIP_REASONS, validateSkip, type Skip } from "./skips.ts";
import { samplePosting } from "./testing/fixtures.ts";

function skip(overrides: Partial<Skip> = {}): Skip {
  return {
    schemaVersion: 1,
    postingId: "0123456789ab",
    reason: "wrong_location",
    skippedAt: "2026-11-10T15:00:00.000Z",
    posting: samplePosting(),
    ...overrides,
  };
}

describe("skip document", () => {
  it.each(SKIP_REASONS)("accepts the %s reason", (reason) => {
    expect(validateSkip(skip({ reason }))).toEqual({ ok: true, value: skip({ reason }) });
  });

  it("rejects an unknown reason", () => {
    const result = validateSkip({ ...skip(), reason: "boring" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatch(/^reason: /);
  });

  it("rejects a snapshot of a different Posting", () => {
    expect(validateSkip(skip({ posting: samplePosting({ id: "ffffffffffff" }) }))).toEqual({
      ok: false,
      issues: ["posting.id: must be the skip's postingId, 0123456789ab"],
    });
  });

  it("is stored under its Posting's id", () => {
    expect(validateDocument(SKIPS_COLLECTION, "0123456789ab", skip()).ok).toBe(true);
    expect(validateDocument(SKIPS_COLLECTION, "aaaaaaaaaaaa", skip())).toEqual({
      ok: false,
      issues: [
        "A skip is stored under its Posting's id: skips/0123456789ab, not skips/aaaaaaaaaaaa.",
      ],
    });
  });
});
