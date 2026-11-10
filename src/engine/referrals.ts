/**
 * Referral Drafts: matching the Candidate's connections to the companies of queued Postings.
 * Pure: the imported connections, the cards, the current Referral Drafts and the Refresh skill's
 * calls in; the referrals documents to write or remove, the matches still to draft, and a summary
 * out. The engine picks which connections to ask; the Refresh skill writes each message (or skips
 * a match that is not really at the company), and the next run turns those calls into documents.
 *
 * A connection is asked once per company, not once per Posting: with several Postings at one
 * company queued, one message names the best-ranked of them, and every queued Posting there shows
 * it. Nothing here sends anything: the Candidate copies each draft and sends it themselves.
 */
import {
  MAX_REFERRAL_DRAFTS,
  type Card,
  type Posting,
  type ReferralDraft,
  type Referrals,
} from "../contract/index.ts";
import { companyKey } from "./companies.ts";
import { FORTUNE_500_BRANDS } from "./fortune-500.ts";

/** One connection from the Candidate's imported connections export. */
export interface Connection {
  name: string;
  company: string;
  position?: string | undefined;
  /** When the Candidate connected, as YYYY-MM-DD. */
  connectedOn?: string | undefined;
}

/** The Refresh skill's call on one match: the message it drafted, or why it skipped the match. */
export type ReferralCall = { message: string } | { skip: string };

/** The Refresh skill's calls, by company key (see ReferralReviewCompany) and connection name. */
export type ReferralCalls = Readonly<Record<string, Readonly<Record<string, ReferralCall>>>>;

/** The most matches one Refresh asks the Refresh skill to draft; the rest wait for the next. */
export const MAX_REFERRAL_REVIEW = 30;

export interface ReferralInput {
  now: string;
  /** The imported connections, or undefined when the Candidate has not imported any. */
  connections: readonly Connection[] | undefined;
  /** Every readable card after this Refresh, including the ones it pre-queued. */
  cards: readonly Card[];
  /** Every card document id, readable or not. */
  cardIds: readonly string[];
  /** The readable referrals documents, by Posting id. */
  current: ReadonlyMap<string, Referrals>;
  /** Every referrals document id, readable or not. */
  currentIds: readonly string[];
  calls: ReferralCalls;
}

/** The most queued Postings at one company a message names. */
export const MAX_ROLES_PER_MESSAGE = 3;

/** A company in the Queue with connections for the Refresh skill to draft messages to. */
export interface ReferralReviewCompany {
  /** The key the Refresh skill records its calls for this company under. */
  key: string;
  company: string;
  /** The company's best-ranked queued Postings, for the message to name. */
  roles: { title: string; roleType: string; applyUrl: string }[];
  /** The connections there with no draft yet, best to ask first. */
  connections: Connection[];
}

export interface ReferralSummary {
  /** Whether the Candidate has imported connections. */
  imported: boolean;
  /** Connections matched to the companies of queued Postings, once per company. */
  matches: number;
  /** Companies in the Queue with at least one Referral Draft. */
  companies: number;
  /** Queued Postings that show at least one Referral Draft. */
  postings: number;
  /** Referral Drafts, one per connection and company. */
  drafts: number;
  /** Matches with no draft yet. */
  toDraft: number;
}

export interface ReferralPlan {
  /** Referrals documents to write whole. */
  set: Referrals[];
  /** Ids of referrals documents to remove. */
  delete: string[];
  /** The best-ranked matches with no draft yet, by company, for the Refresh skill. */
  review: ReferralReviewCompany[];
  /** The calls that still apply, to keep for the next Refresh. */
  calls: Record<string, Record<string, ReferralCall>>;
  summary: ReferralSummary;
}

const BRAND_PARENTS = new Map(
  Object.entries(FORTUNE_500_BRANDS).map(([brand, parent]) => [
    companyKey(brand),
    companyKey(parent),
  ]),
);

/**
 * Whether two company names are one employer: the same name once legal suffixes are gone, a
 * brand and its parent company (Google and Alphabet), or a name and a longer form of it (Amazon
 * and Amazon Web Services). Two brands of one parent (Google and Waymo) are not.
 */
export function sameCompany(a: string, b: string): boolean {
  const ka = companyKey(a);
  const kb = companyKey(b);
  if (ka === "" || kb === "") return false;
  if (ka === kb || BRAND_PARENTS.get(ka) === kb || BRAND_PARENTS.get(kb) === ka) return true;
  const [short, long] = ka.length < kb.length ? [ka, kb] : [kb, ka];
  return long.startsWith(`${short} `);
}

const RECRUITER = /\b(recruit\w*|talent|sourc\w*|university relations)\b/i;
const IGNORED_WORDS = new Set(["and", "the", "for", "new", "grad", "intern", "junior"]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1 && !IGNORED_WORDS.has(word)),
  );
}

/**
 * Connections at the Posting's company, best to ask first: recruiters, then people whose
 * position shares words with the Posting's role type, then the most recent connections.
 */
function rankedMatches(posting: Posting, connections: readonly Connection[]): Connection[] {
  const roleWords = words(posting.roleType);
  const rank = (connection: Connection) => {
    const position = connection.position ?? "";
    const overlap = [...words(position)].filter((word) => roleWords.has(word)).length;
    return { recruiter: RECRUITER.test(position) ? 1 : 0, overlap };
  };
  return connections
    .filter((connection) => sameCompany(connection.company, posting.company))
    .map((connection) => ({ connection, ...rank(connection) }))
    .sort(
      (a, b) =>
        b.recruiter - a.recruiter ||
        b.overlap - a.overlap ||
        (b.connection.connectedOn ?? "").localeCompare(a.connection.connectedOn ?? "") ||
        a.connection.name.localeCompare(b.connection.name),
    )
    .map(({ connection }) => connection);
}

function callFor(calls: ReferralCalls, key: string, name: string): ReferralCall | undefined {
  const forCompany = Object.hasOwn(calls, key) ? calls[key] : undefined;
  return forCompany && Object.hasOwn(forCompany, name) ? forCompany[name] : undefined;
}

function sameDrafts(a: readonly ReferralDraft[], b: readonly ReferralDraft[]): boolean {
  const key = (drafts: readonly ReferralDraft[]) =>
    JSON.stringify(drafts.map((d) => [d.name, d.company, d.position ?? null, d.message]));
  return key(a) === key(b);
}

export function planReferrals(input: ReferralInput): ReferralPlan {
  const { now, connections, current, calls } = input;
  const plan: ReferralPlan = {
    set: [],
    delete: [],
    review: [],
    calls: {},
    summary: {
      imported: connections !== undefined,
      matches: 0,
      companies: 0,
      postings: 0,
      drafts: 0,
      toDraft: 0,
    },
  };
  const withCard = new Set([...input.cardIds, ...input.cards.map((c) => c.postingId)]);
  const removals = new Set(input.currentIds.filter((id) => !withCard.has(id)));
  for (const id of current.keys()) if (!withCard.has(id)) removals.add(id);

  if (connections !== undefined) {
    // Best-ranked Postings first, so the companies the Candidate applies to soonest come first.
    const queued = input.cards
      .filter((c) => c.stage === "queued")
      .map((c) => c.posting)
      .sort(
        (a, b) => a.locationTier - b.locationTier || b.score - a.score || a.id.localeCompare(b.id),
      );
    const byCompany = new Map<string, Posting[]>();
    for (const posting of queued) {
      const key = companyKey(posting.company);
      byCompany.set(key, [...(byCompany.get(key) ?? []), posting]);
    }
    let listed = 0;
    for (const [key, postings] of byCompany) {
      const [best] = postings;
      if (!best || key === "") continue;
      const record = (name: string, call: ReferralCall) => {
        (plan.calls[key] ??= {})[name] = call;
      };
      const asked = rankedMatches(best, connections)
        .filter((connection) => {
          const call = callFor(calls, key, connection.name);
          if (call && "skip" in call) record(connection.name, call);
          return !(call && "skip" in call);
        })
        .slice(0, MAX_REFERRAL_DRAFTS);
      const drafts: ReferralDraft[] = [];
      const toDraft: Connection[] = [];
      for (const connection of asked) {
        const call = callFor(calls, key, connection.name);
        if (call && "message" in call) {
          record(connection.name, call);
          const { name, company, position } = connection;
          drafts.push({
            name,
            company,
            ...(position === undefined ? {} : { position }),
            message: call.message,
          });
        } else {
          toDraft.push(connection);
        }
      }
      plan.summary.matches += asked.length;
      plan.summary.toDraft += toDraft.length;
      const room = MAX_REFERRAL_REVIEW - listed;
      if (toDraft.length > 0 && room > 0) {
        plan.review.push({
          key,
          company: best.company,
          roles: postings.slice(0, MAX_ROLES_PER_MESSAGE).map((p) => ({
            title: p.title,
            roleType: p.roleType,
            applyUrl: p.applyUrl,
          })),
          connections: toDraft.slice(0, room),
        });
        listed += Math.min(room, toDraft.length);
      }
      if (drafts.length > 0) {
        plan.summary.companies += 1;
        plan.summary.drafts += drafts.length;
      }
      for (const posting of postings) {
        const existing = current.get(posting.id);
        if (drafts.length === 0) {
          if (existing || input.currentIds.includes(posting.id)) removals.add(posting.id);
          continue;
        }
        plan.summary.postings += 1;
        if (!existing || !sameDrafts(existing.drafts, drafts)) {
          plan.set.push({ schemaVersion: 1, postingId: posting.id, drafts, updatedAt: now });
        }
      }
    }
  }
  plan.delete = [...removals].sort();
  return plan;
}
