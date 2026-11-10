/**
 * Pre-queueing: after a Refresh ranks the Job List, the best Postings go into the Queue until it
 * holds the daily Queue target. Unsubmitted Queue items carry over and count toward the target,
 * lower Location Tiers only fill the slots higher tiers leave empty, and a Posting the Candidate
 * skipped is never queued again. Pure: the Queue state in, the cards to create and a summary out.
 */
import { POSSIBLY_CLOSED_DAYS, queueAgeDays, type Card, type Posting } from "../contract/index.ts";

/** The Queue as the dashboard database holds it now. */
export interface CurrentQueue {
  /** Every card that matches the contract. */
  cards: readonly Card[];
  /** The id of every card document, readable or not; Refresh never writes over one. */
  cardIds: readonly string[];
  /** The Postings the Candidate skipped. */
  skippedIds: readonly string[];
}

export const EMPTY_QUEUE: CurrentQueue = { cards: [], cardIds: [], skippedIds: [] };

export interface QueueInput {
  now: string;
  dailyQueueTarget: number;
  /** The new Job List, best first. */
  jobList: readonly Posting[];
  queue: CurrentQueue;
}

export interface QueueSummary {
  target: number;
  /** Postings in the Queue after this Refresh. */
  size: number;
  /** Postings this Refresh added to the Queue. */
  preQueued: number;
  /** Postings still in the Queue from before this Refresh. */
  carriedOver: number;
  /** Queue items queued POSSIBLY_CLOSED_DAYS or more days ago. */
  possiblyClosed: number;
  /** Queue items whose Posting is no longer in the Job List. */
  notListed: number;
}

export interface QueuePlan {
  /** New cards to create, in Queue order. */
  cards: Card[];
  summary: QueueSummary;
}

export function planQueue({ now, dailyQueueTarget, jobList, queue }: QueueInput): QueuePlan {
  const nowMs = Date.parse(now);
  const queued = queue.cards.filter((card) => card.stage === "queued");
  const taken = new Set([...queue.cardIds, ...queue.cards.map((c) => c.postingId)]);
  const skipped = new Set(queue.skippedIds);
  const listed = new Set(jobList.map((p) => p.id));

  const open = Math.max(0, dailyQueueTarget - queued.length);
  // A stable sort keeps the Job List's rank order inside each Location Tier.
  const picks = jobList
    .map((posting, rank) => ({ posting, rank }))
    .filter(({ posting }) => !taken.has(posting.id) && !skipped.has(posting.id))
    .sort((a, b) => a.posting.locationTier - b.posting.locationTier || a.rank - b.rank)
    .slice(0, open)
    .map(({ posting }) => posting);

  const cards: Card[] = picks.map((posting) => ({
    schemaVersion: 1,
    postingId: posting.id,
    stage: "queued",
    queuedAt: now,
    queuedBy: "refresh",
    posting,
    updatedAt: now,
  }));

  return {
    cards,
    summary: {
      target: dailyQueueTarget,
      size: queued.length + cards.length,
      preQueued: cards.length,
      carriedOver: queued.length,
      possiblyClosed: queued.filter(
        (card) => queueAgeDays(card.queuedAt, nowMs) >= POSSIBLY_CLOSED_DAYS,
      ).length,
      notListed: queued.filter((card) => !listed.has(card.postingId)).length,
    },
  };
}
