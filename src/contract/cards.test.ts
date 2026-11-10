import { describe, expect, it } from "vitest";
import {
  CARDS_COLLECTION,
  POSSIBLY_CLOSED_DAYS,
  compareQueueOrder,
  finishFill,
  moveCard,
  queueAgeDays,
  stageSince,
  startFill,
  validateCard,
  type Card,
  type FillRecord,
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

const FILLED: FillRecord = {
  at: "2026-11-12T10:05:00.000Z",
  outcome: "filled",
  simplify: "filled",
  resumeVariant: "Generalist SWE",
  flags: [
    {
      field: "Do you meet the basic qualifications?",
      kind: "legal_claim",
      note: "A claim about yourself; answer it before you submit.",
    },
    { field: "Why Acme?", kind: "free_text", note: "Write this answer yourself." },
  ],
};

const NEEDS_SIGN_IN: FillRecord = {
  at: "2026-11-12T10:05:00.000Z",
  outcome: "needs_sign_in",
  simplify: "not_tried",
  flags: [
    {
      field: "Workday account",
      kind: "sign_in",
      note: "Sign in to Acme's Workday in Helium, then ask your Claude to fill this Posting again.",
    },
  ],
};

describe("Fill's record on a card", () => {
  it("accepts a filled card with what Fill flagged", () => {
    expect(validateCard(card({ stage: "ready_for_review", fill: FILLED })).ok).toBe(true);
  });

  it("accepts a Queued card Fill could not fill because it needs a sign-in", () => {
    expect(validateCard(card({ fill: NEEDS_SIGN_IN })).ok).toBe(true);
  });

  it("says what the Candidate must do when a Posting needs a sign-in", () => {
    expect(issuesFor(card({ fill: { ...NEEDS_SIGN_IN, flags: [] } }))).toEqual([
      "fill.flags: a Posting that needs a sign-in has a sign_in flag saying what to do",
    ]);
    expect(issuesFor(card({ fill: { ...FILLED, flags: NEEDS_SIGN_IN.flags } }))).toEqual([
      "fill.flags: only a Posting that needs a sign-in has a sign_in flag",
    ]);
  });

  it("accepts a Fill that stopped, and requires it to say why", () => {
    const stopped: FillRecord = {
      at: "2026-11-12T10:05:00.000Z",
      outcome: "stopped",
      simplify: "not_tried",
      flags: [{ field: "Posting", kind: "problem", note: "The page says the job is closed." }],
    };
    expect(validateCard(card({ fill: stopped })).ok).toBe(true);
    expect(issuesFor(card({ fill: { ...stopped, flags: [] } }))).toEqual([
      "fill.flags: a Fill that stopped has a flag saying why",
    ]);
    const done = finishFill(startFill(card(), "2026-11-12T10:00:00.000Z"), stopped);
    expect(done.stage).toBe("queued");
    expect(done).not.toHaveProperty("fillingSince");
  });

  it("rejects flags without a field or a note, and unknown kinds", () => {
    const flag = (over: object) => ({ ...FILLED, flags: [{ ...FILLED.flags[0], ...over }] });
    expect(issuesFor(card({ fill: flag({ field: " " }) as FillRecord }))).toEqual([
      "fill.flags.0.field: must not be blank",
    ]);
    expect(issuesFor(card({ fill: flag({ note: "" }) as FillRecord }))).toEqual([
      "fill.flags.0.note: must not be blank",
    ]);
    expect(issuesFor(card({ fill: flag({ kind: "guess" }) as FillRecord }))[0]).toMatch(
      /^fill\.flags\.0\.kind:/,
    );
  });

  it("never holds an answer's value, only which field to look at", () => {
    const withValue = { ...FILLED, flags: [{ ...FILLED.flags[0], value: "Yes" }] };
    expect(issuesFor(card({ fill: withValue as FillRecord }))[0]).toMatch(/^fill\.flags\.0/);
  });
});

describe("startFill and finishFill", () => {
  const STARTED = "2026-11-12T10:00:00.000Z";

  it("marks a Queued card as filling", () => {
    const started = startFill(card(), STARTED);
    expect(started).toEqual({ ...card(), fillingSince: STARTED, updatedAt: STARTED });
    expect(validateCard(started).ok).toBe(true);
  });

  it("refuses to start a card that is not Queued", () => {
    expect(() => startFill(card({ stage: "ready_for_review" }), STARTED)).toThrow(
      "Fill works only on Queued cards; this one is Ready for Review.",
    );
  });

  it("moves a filled card to Ready for Review with its flags", () => {
    const done = finishFill(startFill(card(), STARTED), FILLED);
    expect(done.stage).toBe("ready_for_review");
    expect(done.stageChangedAt).toBe(FILLED.at);
    expect(done.updatedAt).toBe(FILLED.at);
    expect(done.fill).toEqual(FILLED);
    expect(done).not.toHaveProperty("fillingSince");
    expect(validateCard(done).ok).toBe(true);
  });

  it("leaves a card that needs a sign-in Queued, flagged, and no longer filling", () => {
    const done = finishFill(startFill(card(), STARTED), NEEDS_SIGN_IN);
    expect(done.stage).toBe("queued");
    expect(done.fill).toEqual(NEEDS_SIGN_IN);
    expect(done).not.toHaveProperty("fillingSince");
    expect(done).not.toHaveProperty("stageChangedAt");
    expect(validateCard(done).ok).toBe(true);
  });

  it("keeps the Stage the Candidate moved the card to while it was filling", () => {
    const moved = card({ stage: "submitted", stageChangedAt: "2026-11-12T10:02:00.000Z" });
    const done = finishFill(moved, FILLED);
    expect(done.stage).toBe("submitted");
    expect(done.stageChangedAt).toBe("2026-11-12T10:02:00.000Z");
    expect(done.fill).toEqual(FILLED);
  });

  it("replaces the record of an earlier Fill", () => {
    const done = finishFill(card({ fill: NEEDS_SIGN_IN }), FILLED);
    expect(done.fill).toEqual(FILLED);
  });
});
