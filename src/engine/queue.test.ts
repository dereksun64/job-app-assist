import { describe, expect, it } from "vitest";
import { validateDocument, type Card, type Posting } from "../contract/index.ts";
import { planQueue, type CurrentQueue } from "./queue.ts";

const NOW = "2026-11-10T15:00:00.000Z";
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

let counter = 0;
function posting(overrides: Partial<Posting> = {}): Posting {
  counter += 1;
  return {
    id: counter.toString(16).padStart(12, "0"),
    applyUrl: `https://jobs.lever.co/acme/${String(counter)}`,
    company: `Company ${String(counter)}`,
    title: "Software Engineer, New Grad",
    locations: ["New York, NY"],
    locationTier: 1,
    roleType: "Software Engineer",
    level: "new_grad",
    postedOn: "2026-11-08",
    sources: [{ name: "Job Feed" }],
    score: 80,
    boosts: [],
    resumeVariant: { name: "Generalist SWE", reason: "Your only Resume Variant." },
    ...overrides,
  };
}

function card(of: Posting, overrides: Partial<Card> = {}): Card {
  return {
    schemaVersion: 1,
    postingId: of.id,
    stage: "queued",
    queuedAt: daysAgo(1),
    queuedBy: "refresh",
    posting: of,
    updatedAt: daysAgo(1),
    ...overrides,
  };
}

const noQueue: CurrentQueue = { cards: [], cardIds: [], skippedIds: [] };

function queueOf(cards: Card[], skippedIds: string[] = []): CurrentQueue {
  return { cards, cardIds: cards.map((c) => c.postingId), skippedIds };
}

function plan(jobList: Posting[], queue: CurrentQueue = noQueue, dailyQueueTarget = 3) {
  return planQueue({ now: NOW, dailyQueueTarget, jobList, queue });
}

const ids = (cards: readonly Card[]) => cards.map((c) => c.postingId);

describe("pre-queueing", () => {
  it("queues the top-ranked Postings up to the daily Queue target", () => {
    const list = [posting(), posting(), posting(), posting(), posting()];
    const { cards, summary } = plan(list);
    expect(ids(cards)).toEqual(list.slice(0, 3).map((p) => p.id));
    expect(summary).toMatchObject({ target: 3, size: 3, preQueued: 3, carriedOver: 0 });
  });

  it("writes cards in the queued Stage with a snapshot of each Posting", () => {
    const top = posting();
    const { cards } = plan([top], noQueue, 1);
    expect(cards).toEqual([
      {
        schemaVersion: 1,
        postingId: top.id,
        stage: "queued",
        queuedAt: NOW,
        queuedBy: "refresh",
        posting: top,
        updatedAt: NOW,
      },
    ]);
    expect(validateDocument("cards", top.id, cards[0]).ok).toBe(true);
  });

  it("queues fewer when the Job List is shorter than the target", () => {
    const { cards, summary } = plan([posting()], noQueue, 20);
    expect(cards).toHaveLength(1);
    expect(summary).toMatchObject({ target: 20, size: 1, preQueued: 1 });
  });

  it("fills from higher Location Tiers first; lower tiers only fill what is left", () => {
    const tier2 = posting({ locationTier: 2, score: 99 });
    const tier1a = posting({ locationTier: 1, score: 60 });
    const tier3 = posting({ locationTier: 3, score: 100 });
    const tier1b = posting({ locationTier: 1, score: 50 });
    const { cards } = plan([tier2, tier1a, tier3, tier1b]);
    expect(ids(cards)).toEqual([tier1a.id, tier1b.id, tier2.id]);
  });

  it("keeps the Job List's rank order within a Location Tier", () => {
    const list = [posting({ score: 70 }), posting({ score: 90 }), posting({ score: 80 })];
    expect(ids(plan(list).cards)).toEqual(list.map((p) => p.id));
  });

  it("never pre-queues a skipped Posting, and fills its slot with the next one", () => {
    const list = [posting(), posting(), posting(), posting()];
    const skipped = [list[0]?.id ?? "", list[2]?.id ?? ""];
    const { cards } = plan(list, queueOf([], skipped), 2);
    expect(ids(cards)).toEqual([list[1]?.id, list[3]?.id]);
  });

  it("does not pre-queue anything when the target is already met", () => {
    const list = [posting(), posting(), posting(), posting()];
    const queue = queueOf(list.slice(1, 4).map((p) => card(p)));
    const { cards, summary } = plan(list, queue);
    expect(cards).toEqual([]);
    expect(summary).toMatchObject({ size: 3, preQueued: 0, carriedOver: 3 });
  });
});

describe("carry-over", () => {
  it("counts unsubmitted Queue items toward the target and never rewrites them", () => {
    const list = [posting(), posting(), posting(), posting()];
    const queue = queueOf([card(list[1] as Posting, { queuedBy: "candidate" })]);
    const { cards, summary } = plan(list, queue);
    expect(ids(cards)).toEqual([list[0]?.id, list[2]?.id]);
    expect(summary).toMatchObject({ size: 3, preQueued: 2, carriedOver: 1 });
  });

  it("keeps a queued Posting that left the Job List, and counts it", () => {
    const gone = posting();
    const list = [posting(), posting()];
    const { cards, summary } = plan(list, queueOf([card(gone)]));
    expect(ids(cards)).toEqual(list.map((p) => p.id));
    expect(summary).toMatchObject({ size: 3, carriedOver: 1, notListed: 1 });
  });

  it("keeps carried-over items past the target rather than dropping any", () => {
    const queued = [posting(), posting(), posting(), posting()];
    const { cards, summary } = plan(queued, queueOf(queued.map((p) => card(p))));
    expect(cards).toEqual([]);
    expect(summary).toMatchObject({ target: 3, size: 4, carriedOver: 4 });
  });

  it("flags Queue items five or more days old as possibly closed", () => {
    const queued = [posting(), posting(), posting()];
    const queue = queueOf([
      card(queued[0] as Posting, { queuedAt: daysAgo(4.9) }),
      card(queued[1] as Posting, { queuedAt: daysAgo(5) }),
      card(queued[2] as Posting, { queuedAt: daysAgo(12) }),
    ]);
    expect(plan(queued, queue).summary.possiblyClosed).toBe(2);
  });

  it("leaves Postings past the queued Stage alone and out of the Queue count", () => {
    const list = [posting(), posting(), posting()];
    const queue = queueOf([card(list[0] as Posting, { stage: "submitted" })]);
    const { cards, summary } = plan(list, queue, 2);
    expect(ids(cards)).toEqual([list[1]?.id, list[2]?.id]);
    expect(summary).toMatchObject({ size: 2, carriedOver: 0 });
  });

  it("never overwrites a card it could not read", () => {
    const list = [posting(), posting()];
    const queue: CurrentQueue = { cards: [], cardIds: [list[0]?.id ?? ""], skippedIds: [] };
    expect(ids(plan(list, queue, 1).cards)).toEqual([list[1]?.id]);
  });
});
