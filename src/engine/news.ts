/**
 * The deterministic half of the News Digest. `planNews` computes the hiring signals from the
 * Candidate's own Job List and lists what the Refresh skill should research in chat (the
 * companies in the Queue, and sources already covered this week). `buildDigest` joins those
 * signals with the news the skill gathered into one contract document. No network or Claude
 * calls happen here: news gathering is the Refresh skill's work in chat (ADR 0002).
 */
import {
  MAX_SIGNAL_POSTINGS,
  NEWS_DAYS_KEPT,
  isoDaySchema,
  validateNewsDocument,
  type Card,
  type HiringSignal,
  type NewsDigest,
  type Posting,
  type Validation,
} from "../contract/index.ts";
import * as z from "zod/mini";
import { companyKey, displayCompany, UNKNOWN_COMPANY } from "./companies.ts";

/** A Posting counts toward this week's signals when it went up in the last 7 days. */
export const HIRING_SIGNAL_DAYS = 7;
export const MAX_HIRING_SIGNALS = 12;

/** Boosts too common to make a company stand out on their own: the Job Feed's lower tiers. */
const MINOR_BOOSTS = /^Company tier (3|4)$/;

const DAY_MS = 86_400_000;

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day a moment falls on in a time zone, as YYYY-MM-DD. */
export function dayIn(iso: string, timeZone: string): string {
  // The en-CA locale writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export interface NewsPlanInput {
  /** The Candidate's local day the digest is for. */
  day: string;
  /** The Job List, as this Refresh wrote it. */
  postings: readonly Posting[];
  cards: readonly Card[];
  /** Digests already in the dashboard. */
  recent: readonly NewsDigest[];
}

export interface NewsPlan {
  day: string;
  newThisWeek: number;
  hiringSignals: HiringSignal[];
  /** Companies in the Queue, each once, for the company news section. */
  queueCompanies: string[];
  /** Sources linked by the digests of the past week, so the skill does not repeat them. */
  recentUrls: string[];
}

function hiringSignals(thisWeek: readonly Posting[]): HiringSignal[] {
  const byCompany = new Map<string, Posting[]>();
  for (const posting of thisWeek) {
    if (!posting.boosts.some((boost) => !MINOR_BOOSTS.test(boost))) continue;
    const key = companyKey(posting.company);
    byCompany.set(key, [...(byCompany.get(key) ?? []), posting]);
  }
  return [...byCompany.values()]
    .map((postings) => {
      const newest = [...postings].sort(
        (a, b) => b.postedOn.localeCompare(a.postedOn) || b.score - a.score,
      );
      const lead = newest[0] as Posting;
      return {
        company: lead.company,
        boosts: lead.boosts.filter((boost) => !MINOR_BOOSTS.test(boost)),
        newPostings: postings.length,
        postings: newest
          .slice(0, MAX_SIGNAL_POSTINGS)
          .map(({ id, title, level, postedOn, applyUrl }) => ({
            id,
            title,
            level,
            postedOn,
            applyUrl,
          })),
      };
    })
    .sort(
      (a, b) =>
        b.newPostings - a.newPostings ||
        Number(b.boosts.includes("Fortune 500")) - Number(a.boosts.includes("Fortune 500")) ||
        a.company.localeCompare(b.company),
    )
    .slice(0, MAX_HIRING_SIGNALS);
}

function queueCompanies(cards: readonly Card[]): string[] {
  const names = new Map<string, string>();
  const queued = cards
    .filter((card) => card.stage === "queued")
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  for (const { posting } of queued) {
    const name = displayCompany(posting.company);
    const key = companyKey(name);
    if (name === UNKNOWN_COMPANY || key === "" || names.has(key)) continue;
    names.set(key, name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function recentUrls(recent: readonly NewsDigest[], day: string): string[] {
  const since = addDays(day, -HIRING_SIGNAL_DAYS);
  const urls = new Set<string>();
  for (const digest of recent) {
    if (digest.day >= day || digest.day < since) continue;
    for (const item of [...digest.forumHighlights, ...digest.companyNews, ...digest.industryNews]) {
      urls.add(item.url);
    }
  }
  return [...urls].sort();
}

/** What the digest's deterministic half produces, and what the skill should research. */
export function planNews({ day, postings, cards, recent }: NewsPlanInput): NewsPlan {
  const since = addDays(day, -(HIRING_SIGNAL_DAYS - 1));
  const thisWeek = postings.filter((p) => p.postedOn >= since && p.postedOn <= day);
  return {
    day,
    newThisWeek: thisWeek.length,
    hiringSignals: hiringSignals(thisWeek),
    queueCompanies: queueCompanies(cards),
    recentUrls: recentUrls(recent, day),
  };
}

const GATHERED_SECTIONS = ["forumHighlights", "companyNews", "industryNews", "gaps"] as const;
const SECTION_LIST = "forumHighlights, companyNews, industryNews and gaps";

/**
 * Joins the plan's hiring signals with the news the Refresh skill gathered (an object holding
 * `forumHighlights`, `companyNews`, `industryNews` and `gaps`) into one News Digest.
 * Problems are reported by their place in the gathered news, so the skill can fix them there.
 */
export function buildDigest(
  plan: NewsPlan,
  gathered: unknown,
  builtAt: string,
): Validation<NewsDigest> {
  if (typeof gathered !== "object" || gathered === null || Array.isArray(gathered)) {
    return {
      ok: false,
      issues: [`The gathered news must be an object with ${SECTION_LIST}.`],
    };
  }
  const extra = Object.keys(gathered).filter(
    (key) => !(GATHERED_SECTIONS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    return {
      ok: false,
      issues: extra.map((key) => `${key}: is not a news section; write only ${SECTION_LIST}`),
    };
  }
  const sections = gathered as Record<string, unknown>;
  const digest = {
    schemaVersion: 1,
    day: plan.day,
    builtAt,
    newThisWeek: plan.newThisWeek,
    hiringSignals: plan.hiringSignals,
    forumHighlights: sections.forumHighlights ?? [],
    companyNews: sections.companyNews ?? [],
    industryNews: sections.industryNews ?? [],
    gaps: sections.gaps ?? [],
  };
  const result = validateNewsDocument(plan.day, digest);
  if (!result.ok) return result;
  const value = result.value as NewsDigest;
  const queue = new Set(plan.queueCompanies.map(companyKey));
  const outside = value.companyNews.flatMap((item, i) =>
    queue.has(companyKey(item.company))
      ? []
      : [
          `companyNews.${String(i)}.company: "${item.company}" is not in the Queue; company news covers only ${plan.queueCompanies.join(", ") || "companies in the Queue, and the Queue is empty"}`,
        ],
  );
  return outside.length > 0 ? { ok: false, issues: outside } : { ok: true, value };
}

/** Digest days older than the days the dashboard keeps, oldest first. */
export function staleNewsDays(days: readonly string[], today: string): string[] {
  const oldest = addDays(today, -(NEWS_DAYS_KEPT - 1));
  return days.filter((day) => z.safeParse(isoDaySchema, day).success && day < oldest).sort();
}
