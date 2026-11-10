import { describe, expect, it } from "vitest";
import {
  CARDS_COLLECTION,
  POSSIBLY_CLOSED_DAYS,
  compareQueueOrder,
  moveCard,
  queueAgeDays,
  stageSince,
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

  it.each(["queued", "ready_for_review", "submitted", "interviewing", "offer"] as const)(
    "accepts the %s Stage",
    (stage) => {
      expect(validateCard(card({ stage })).ok).toBe(true);
    },
  );

  it.each(["rejected", "withdrawn"] as const)("accepts a card Closed as %s", (closedReason) => {
    expect(validateCard(card({ stage: "closed", closedReason })).ok).toBe(true);
  });

  it("requires a reason on a Closed card, and only there", () => {
    expect(issuesFor(card({ stage: "closed" }))).toEqual([
      "closedReason: a Closed card says whether the Candidate was rejected or withdrew",
    ]);
    expect(issuesFor(card({ stage: "offer", closedReason: "rejected" }))).toEqual([
      "closedReason: only a Closed card has a closedReason",
    ]);
    expect(issuesFor({ ...card({ stage: "closed" }), closedReason: "ghosted" })[0]).toMatch(
      /^closedReason: /,
    );
  });

  it("marks a Queued card as filling, which is not a Stage", () => {
    expect(validateCard(card({ fillingSince: "2026-11-10T16:00:00.000Z" })).ok).toBe(true);
    expect(
      issuesFor(card({ stage: "submitted", fillingSince: "2026-11-10T16:00:00.000Z" })),
    ).toEqual(["fillingSince: only a Queued card can be filling"]);
  });

  it("records when the card entered its Stage", () => {
    expect(validateCard(card({ stageChangedAt: "2026-11-11T09:00:00.000Z" })).ok).toBe(true);
    expect(issuesFor({ ...card(), stageChangedAt: "yesterday" })[0]).toMatch(/^stageChangedAt: /);
  });

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

describe("moveCard", () => {
  const AT = "2026-11-12T10:00:00.000Z";

  it("moves a card to a new Stage and stamps the move", () => {
    expect(moveCard(card(), "submitted", AT)).toEqual({
      ...card(),
      stage: "submitted",
      stageChangedAt: AT,
      updatedAt: AT,
    });
  });

  it("closes a card with its reason, and drops the reason when it reopens", () => {
    const closed = moveCard(card({ stage: "interviewing" }), "closed", AT, "withdrawn");
    expect(closed).toMatchObject({ stage: "closed", closedReason: "withdrawn" });
    expect(validateCard(closed).ok).toBe(true);
    const reopened = moveCard(closed, "interviewing", AT);
    expect(reopened).not.toHaveProperty("closedReason");
    expect(validateCard(reopened).ok).toBe(true);
  });

  it("changes the reason on an already Closed card", () => {
    const closed = card({ stage: "closed", closedReason: "rejected" });
    expect(moveCard(closed, "closed", AT, "withdrawn")).toMatchObject({
      closedReason: "withdrawn",
      stageChangedAt: AT,
    });
  });

  it("refuses to close a card without a reason", () => {
    expect(() => moveCard(card(), "closed", AT)).toThrow(/rejected or withdrawn/);
  });

  it("clears the filling marker, whichever way the card moves", () => {
    const filling = card({ fillingSince: "2026-11-12T09:58:00.000Z" });
    expect(moveCard(filling, "ready_for_review", AT)).not.toHaveProperty("fillingSince");
    expect(moveCard(filling, "closed", AT, "withdrawn")).not.toHaveProperty("fillingSince");
  });
});

describe("stageSince", () => {
  it("is when the card entered its Stage, or when it was queued if it never moved", () => {
    expect(stageSince(card())).toBe("2026-11-10T15:00:00.000Z");
    expect(stageSince(card({ stageChangedAt: "2026-11-12T10:00:00.000Z" }))).toBe(
      "2026-11-12T10:00:00.000Z",
    );
  });
});

describe("compareQueueOrder", () => {
  it("puts older cards first, then the better Location Tier, then the higher score", () => {
    const of = (id: string, queuedAt: string, locationTier: number, score: number) =>
      card({
        postingId: id,
        queuedAt,
        posting: samplePosting({ id, locationTier, score }),
      });
    const today = "2026-11-10T15:00:00.000Z";
    const cards = [
      of("00000000000a", today, 2, 99),
      of("00000000000b", today, 1, 70),
      of("00000000000c", "2026-11-08T15:00:00.000Z", 3, 10),
      of("00000000000d", today, 1, 90),
      of("00000000000e", today, 1, 90),
    ];
    expect(cards.sort(compareQueueOrder).map((c) => c.postingId)).toEqual([
      "00000000000c",
      "00000000000d",
      "00000000000e",
      "00000000000b",
      "00000000000a",
    ]);
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
