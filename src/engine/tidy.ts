/**
 * Tidy: what to remove from the dashboard database when it is full. The database caps how many
 * documents and how many bytes one dashboard holds, and most collections are bounded already
 * (the Job List is rewritten whole, Refresh drops old News Digests and unused Referral Drafts).
 * What keeps growing is the history: a card, a Prepared Application and often a Resume Variant
 * choice for every Posting ever queued, and a skip for every Posting ever unticked.
 *
 * Tidy removes only history the Candidate no longer acts on: Closed cards that have stayed
 * Closed for a while, with their answers, Referral Drafts and Resume Variant choice; answers,
 * drafts and choices left behind with no card and no Posting in the Job List; old skips whose
 * Posting has left the Job List, so it can never be queued again anyway; and News Digests past
 * the days the dashboard keeps. Open cards, settings, Sources and the Job List are never touched.
 */
import {
  APPLICATIONS_COLLECTION,
  CARDS_COLLECTION,
  NEWS_COLLECTION,
  REFERRALS_COLLECTION,
  SKIPS_COLLECTION,
  VARIANT_OVERRIDES_COLLECTION,
  type Card,
} from "../contract/index.ts";
import { staleNewsDays } from "./news.ts";

/** A Closed card stays this many days after it closed before Tidy offers to remove it. */
export const CLOSED_KEPT_DAYS = 30;
/** A skip stays this many days; Tune reads only the last 90 days of skip reasons. */
export const SKIPS_KEPT_DAYS = 180;

const DAY_MS = 86_400_000;

export interface TidyState {
  cards: readonly Card[];
  /** Ids of card documents outside the contract: they and their documents always stay. */
  unreadableCards: readonly string[];
  /** Document ids (Posting ids) in each collection that is keyed by Posting. */
  applications: readonly string[];
  referrals: readonly string[];
  variantOverrides: readonly string[];
  skips: readonly { postingId: string; skippedAt: string }[];
  /** News Digest document ids, one ISO day each. */
  newsDays: readonly string[];
  /** The ids of the Postings in the current Job List. */
  jobList: readonly string[];
  /** How many documents the dashboard database holds now. */
  documentCount: number;
}

export interface TidyOptions {
  /** Days a card stays Closed before it goes; the default is {@link CLOSED_KEPT_DAYS}. */
  closedDays?: number;
  /** Today in the Candidate's time zone, for News Digests; defaults to the UTC day of `now`. */
  today?: string;
}

export interface TidyDelete {
  collection: string;
  docId: string;
}

export interface TidyPlan {
  deletes: TidyDelete[];
  closedCards: number;
  leftovers: number;
  oldSkips: number;
  oldDigests: number;
  documentsAfter: number;
}

const daysSince = (iso: string, now: number) => (now - Date.parse(iso)) / DAY_MS;

export function planTidy(state: TidyState, now: string, options: TidyOptions = {}): TidyPlan {
  const at = Date.parse(now);
  const closedDays = options.closedDays ?? CLOSED_KEPT_DAYS;
  const deletes: TidyDelete[] = [];
  const has = {
    [APPLICATIONS_COLLECTION]: new Set(state.applications),
    [REFERRALS_COLLECTION]: new Set(state.referrals),
    [VARIANT_OVERRIDES_COLLECTION]: new Set(state.variantOverrides),
  };
  const belonging = Object.keys(has) as (keyof typeof has)[];

  const removedCards = new Set<string>();
  for (const card of state.cards) {
    if (card.stage !== "closed") continue;
    if (daysSince(card.stageChangedAt ?? card.queuedAt, at) < closedDays) continue;
    removedCards.add(card.postingId);
    deletes.push({ collection: CARDS_COLLECTION, docId: card.postingId });
    for (const collection of belonging) {
      if (has[collection].has(card.postingId)) {
        deletes.push({ collection, docId: card.postingId });
      }
    }
  }

  const kept = new Set([
    ...state.cards.map((c) => c.postingId).filter((id) => !removedCards.has(id)),
    ...state.unreadableCards,
    ...state.jobList,
  ]);
  const orphans = [...new Set(belonging.flatMap((collection) => [...has[collection]]))].filter(
    (id) => !kept.has(id) && !removedCards.has(id),
  );
  let leftovers = 0;
  for (const id of orphans.sort()) {
    for (const collection of belonging) {
      if (!has[collection].has(id)) continue;
      deletes.push({ collection, docId: id });
      leftovers += 1;
    }
  }

  const listed = new Set(state.jobList);
  const oldSkips = state.skips
    .filter((s) => !listed.has(s.postingId) && daysSince(s.skippedAt, at) >= SKIPS_KEPT_DAYS)
    .map((s) => s.postingId)
    .sort();
  for (const id of oldSkips) deletes.push({ collection: SKIPS_COLLECTION, docId: id });

  const digests = staleNewsDays(state.newsDays, options.today ?? now.slice(0, 10));
  for (const day of digests) deletes.push({ collection: NEWS_COLLECTION, docId: day });

  return {
    deletes,
    closedCards: removedCards.size,
    leftovers,
    oldSkips: oldSkips.length,
    oldDigests: digests.length,
    documentsAfter: Math.max(0, state.documentCount - deletes.length),
  };
}
