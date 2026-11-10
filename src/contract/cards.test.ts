import { describe, expect, it } from "vitest";
import {
  CARDS_COLLECTION,
  POSSIBLY_CLOSED_DAYS,
  queueAgeDays,
  validateCard,
  type Card,
} from "./cards.ts";
import { validateDocument } from "./index.ts";
import { samplePosting } from "./testing/fixtures.ts";

function card(overrides: Partial<Card> = {}): Card {
  return {
    schemaVersion: 1,
    postingId: "0123456789ab",
    stage: "queued",
    queuedAt: "2026-11-10T15:00:00.000Z",
    queuedBy: "refresh",
    posting: samplePosting(),
    updatedAt: "2026-11-10T15:00:00.000Z",
    ...overrides,
  };
}

function issuesFor(input: unknown): string[] {
  const result = validateCard(input);
  if (result.ok) throw new Error("expected the card to be rejected");
  return result.issues;
}

describe("card document", () => {
  it("accepts a queued card holding a snapshot of its Posting", () => {
    expect(validateCard(card())).toEqual({ ok: true, value: card() });
  });

  it("accepts a card the Candidate queued by hand", () => {
    expect(validateCard(card({ queuedBy: "candidate" })).ok).toBe(true);
  });

  it.each(["queued", "ready_for_review", "submitted", "interviewing", "offer", "closed"] as const)(
    "accepts the %s Stage",
    (stage) => {
      expect(validateCard(card({ stage })).ok).toBe(true);
    },
  );

  it("rejects an unknown Stage and an unknown way of queueing", () => {
    expect(issuesFor({ ...card(), stage: "filling" })[0]).toMatch(/^stage: /);
    expect(issuesFor({ ...card(), queuedBy: "friend" })[0]).toMatch(/^queuedBy: /);
  });

  it("rejects a snapshot of a different Posting", () => {
    expect(issuesFor(card({ posting: samplePosting({ id: "ffffffffffff" }) }))).toEqual([
      "posting.id: must be the card's postingId, 0123456789ab",
    ]);
  });

  it("rejects fields outside the contract", () => {
    expect(issuesFor({ ...card(), notes: "hi" }).length).toBeGreaterThan(0);
  });

  it("is stored under its Posting's id", () => {
    expect(validateDocument(CARDS_COLLECTION, "0123456789ab", card()).ok).toBe(true);
    expect(validateDocument(CARDS_COLLECTION, "aaaaaaaaaaaa", card())).toEqual({
      ok: false,
      issues: [
        "A card is stored under its Posting's id: cards/0123456789ab, not cards/aaaaaaaaaaaa.",
      ],
    });
  });
});

describe("queueAgeDays", () => {
  it("counts whole days since a Posting was queued", () => {
    const queuedAt = "2026-11-05T15:00:00.000Z";
    expect(queueAgeDays(queuedAt, Date.parse("2026-11-05T23:00:00.000Z"))).toBe(0);
    expect(queueAgeDays(queuedAt, Date.parse("2026-11-06T15:00:00.000Z"))).toBe(1);
    expect(queueAgeDays(queuedAt, Date.parse("2026-11-10T14:59:00.000Z"))).toBe(4);
    expect(queueAgeDays(queuedAt, Date.parse("2026-11-10T15:00:00.000Z"))).toBe(
      POSSIBLY_CLOSED_DAYS,
    );
  });

  it("never counts below zero", () => {
    expect(queueAgeDays("2026-11-10T15:00:00.000Z", Date.parse("2026-11-09T00:00:00.000Z"))).toBe(
      0,
    );
  });
});
