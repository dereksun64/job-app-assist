import { describe, expect, it } from "vitest";
import type { Card } from "../contract/index.ts";
import { planTidy, type TidyState } from "./tidy.ts";

const NOW = "2026-11-10T15:00:00.000Z";

function card(id: string, stage: Card["stage"], changedDaysAgo: number): Card {
  const at = new Date(Date.parse(NOW) - changedDaysAgo * 86_400_000).toISOString();
  return {
    schemaVersion: 1,
    postingId: id,
    stage,
    ...(stage === "closed" ? { closedReason: "rejected" as const } : {}),
    queuedAt: "2026-01-01T00:00:00.000Z",
    queuedBy: "refresh",
    stageChangedAt: at,
    posting: {
      id,
      company: `Company ${id}`,
      title: "Software Engineer",
      locations: ["Remote"],
      applyUrl: `https://example.com/${id}`,
      sources: [{ name: "Job Feed" }],
    },
    updatedAt: at,
  } as Card;
}

function state(partial: Partial<TidyState>): TidyState {
  return {
    cards: [],
    applications: [],
    referrals: [],
    variantOverrides: [],
    skips: [],
    newsDays: [],
    unreadableCards: [],
    jobList: [],
    documentCount: 0,
    ...partial,
  };
}

const paths = (plan: ReturnType<typeof planTidy>) =>
  plan.deletes.map((d) => `${d.collection}/${d.docId}`);

describe("planTidy", () => {
  it("removes Closed cards older than 30 days with everything that belongs to them", () => {
    const plan = planTidy(
      state({
        cards: [card("aaaaaaaaaaaa", "closed", 31), card("bbbbbbbbbbbb", "closed", 29)],
        applications: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
        referrals: ["aaaaaaaaaaaa"],
        variantOverrides: ["aaaaaaaaaaaa"],
      }),
      NOW,
    );
    expect(paths(plan)).toEqual([
      "cards/aaaaaaaaaaaa",
      "applications/aaaaaaaaaaaa",
      "referrals/aaaaaaaaaaaa",
      "variantOverrides/aaaaaaaaaaaa",
    ]);
    expect(plan.closedCards).toBe(1);
  });

  it("never removes a card that is still open, however old", () => {
    const plan = planTidy(
      state({
        cards: (["queued", "ready_for_review", "submitted", "interviewing", "offer"] as const).map(
          (stage, i) => card(String(i).repeat(12), stage, 400),
        ),
      }),
      NOW,
    );
    expect(plan.deletes).toEqual([]);
  });

  it("lets the Candidate choose a shorter wait for Closed cards", () => {
    const plan = planTidy(state({ cards: [card("aaaaaaaaaaaa", "closed", 2)] }), NOW, {
      closedDays: 0,
    });
    expect(paths(plan)).toEqual(["cards/aaaaaaaaaaaa"]);
  });

  it("falls back to when a card was queued when it never moved", () => {
    const old = { ...card("aaaaaaaaaaaa", "closed", 0), stageChangedAt: undefined };
    old.queuedAt = "2026-01-01T00:00:00.000Z";
    const plan = planTidy(state({ cards: [old] }), NOW);
    expect(paths(plan)).toEqual(["cards/aaaaaaaaaaaa"]);
  });

  it("removes answers, drafts and Resume Variant choices left with no card and no Posting", () => {
    const plan = planTidy(
      state({
        applications: ["cccccccccccc", "dddddddddddd"],
        referrals: ["cccccccccccc"],
        variantOverrides: ["cccccccccccc", "eeeeeeeeeeee"],
        jobList: ["eeeeeeeeeeee"],
        cards: [card("dddddddddddd", "queued", 1)],
      }),
      NOW,
    );
    expect(paths(plan)).toEqual([
      "applications/cccccccccccc",
      "referrals/cccccccccccc",
      "variantOverrides/cccccccccccc",
    ]);
    expect(plan.leftovers).toBe(3);
  });

  it("keeps everything that belongs to a card it could not read", () => {
    const plan = planTidy(
      state({ applications: ["cccccccccccc"], unreadableCards: ["cccccccccccc"] }),
      NOW,
    );
    expect(plan.deletes).toEqual([]);
  });

  it("removes skips older than 180 days whose Posting left the Job List", () => {
    const skip = (id: string, daysAgo: number) => ({
      postingId: id,
      skippedAt: new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString(),
    });
    const plan = planTidy(
      state({
        skips: [skip("aaaaaaaaaaaa", 200), skip("bbbbbbbbbbbb", 200), skip("cccccccccccc", 100)],
        jobList: ["bbbbbbbbbbbb"],
      }),
      NOW,
    );
    expect(paths(plan)).toEqual(["skips/aaaaaaaaaaaa"]);
    expect(plan.oldSkips).toBe(1);
  });

  it("removes News Digests older than the dashboard keeps", () => {
    const plan = planTidy(state({ newsDays: ["2026-05-01", "2026-11-09"] }), NOW, {
      today: "2026-11-10",
    });
    expect(paths(plan)).toEqual(["news/2026-05-01"]);
    expect(plan.oldDigests).toBe(1);
  });

  it("counts what stays", () => {
    const plan = planTidy(
      state({ cards: [card("aaaaaaaaaaaa", "closed", 60)], documentCount: 120 }),
      NOW,
    );
    expect(plan.documentsAfter).toBe(119);
  });
});
