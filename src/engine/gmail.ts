/**
 * Gmail Stage tracking: the deterministic part of reading the Candidate's email on Refresh.
 *
 * The Refresh skill searches the Candidate's Gmail read-only with the queries `gmailSearchPlan`
 * gives, and saves what it finds as `Email`s (sender, date, subject and a short snippet) in the
 * Candidate folder. `planGmailMoves` then classifies each email (confirmation, assessment,
 * interview, offer, rejection), matches it to a card by company, and moves the card forward when
 * both are clear. Emails the rules cannot settle go to Claude for judgment, and its calls come
 * back as `GmailJudgment`s. Each move keeps only the email's company, date and subject on the
 * card, and an email that has moved a card once never moves a card again.
 */
import * as z from "zod/mini";
import {
  STAGES,
  hasEmail,
  moveCardByEmail,
  needsFollowUp,
  stageSince,
  type Card,
  type EmailFacts,
  type EmailStage,
  type Stage,
} from "../contract/index.ts";

/** The kinds of email that move a card, in the order a Candidate meets them. */
export const EMAIL_KINDS = [
  "confirmation",
  "assessment",
  "interview",
  "offer",
  "rejection",
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** The Stage each kind of email moves a card to. */
export const STAGE_OF_KIND: Record<EmailKind, EmailStage> = {
  confirmation: "submitted",
  assessment: "interviewing",
  interview: "interviewing",
  offer: "offer",
  rejection: "closed",
};

/** How far before a card was queued its emails still count: Candidates sometimes tick late. */
export const EMAIL_LOOKBACK_DAYS = 7;
/** The furthest back a Gmail search reaches. */
export const MAX_SEARCH_DAYS = 90;
/** Companies per Gmail search, so each query stays short. */
const COMPANIES_PER_QUERY = 15;
const SUBJECT_MAX = 300;
const DAY_MS = 86_400_000;

/** One email as the Refresh skill saves it from Gmail, in the Candidate folder only. */
export const emailSchema = z.strictObject({
  /** Gmail's message id; it stays in the Candidate folder. */
  id: z.string().check(z.minLength(1, "must not be blank")),
  /** The From header, for example `Acme Recruiting <jobs@acme.com>`. */
  from: z.string().check(z.minLength(1, "must not be blank")),
  receivedAt: z.iso.datetime({ error: "must be an ISO 8601 timestamp" }),
  subject: z.string(),
  /** Gmail's short preview of the email, used to classify it and never stored on a card. */
  snippet: z.optional(z.string()),
});
export type Email = z.output<typeof emailSchema>;

/** Claude's call on an email the rules left unsure: the card and kind, or not about any card. */
export type GmailJudgment = { postingId: string; kind: EmailKind } | { ignore: true };

export const gmailJudgmentSchema = z.union([
  z.strictObject({
    postingId: z.string().check(z.regex(/^[0-9a-f]{12}$/, "must be a Posting id")),
    kind: z.enum(EMAIL_KINDS),
  }),
  z.strictObject({ ignore: z.literal(true) }),
]);

const KIND_PATTERNS: Record<EmailKind, RegExp> = {
  confirmation:
    /\bthanks? (you )?for (applying|your application|your interest)|\bapplication (received|submitted|confirmation)|\breceived your application|\byour application (has been|was) (received|submitted)/,
  assessment:
    /\bassessments?\b|\bcoding (challenge|test|exercise|assignment)|\bhackerrank\b|\bcodesignal\b|\bcodility\b|\bhirevue\b|\btake[- ]home\b|\binvited you to (a|an|the) (test|assessment|challenge)|\bonline test\b/,
  interview:
    /\binterviews?\b|\bphone screen|\brecruiter (call|screen|chat)|\bschedule (a |an |the |your )?(call|chat|time|conversation|meeting)|\bon-?site\b|\bsuperday\b|\bmeet (with )?the team/,
  offer:
    /\boffer (letter|of employment|details|package)\b|\bpleased to (extend|offer)\b|\bextend(ing)? (you )?an offer|\byour offer\b|\b(job|employment) offer\b|\boffer from\b/,
  rejection:
    /\bunfortunately\b|\bregret to inform|\bnot (be )?mov(e|ing) forward|\b(decided|chosen|chose|elected) to (move|proceed|pursue|go) (forward )?with other|\bother candidates\b|\bno longer (being )?(considered|under consideration)|\b(position|role) (has been|is|was) filled|\bnot (been )?selected\b|\bwill not be (moving|proceeding)|\bunable to (offer|move forward)/,
};

/** Job alerts and recommendations name companies and roles but say nothing about an application. */
const ALERT_PATTERN =
  /\bjobs? (you may|you might) (be interested in|like)|\byou may be interested in\b|\bnew jobs? (at|for|matching)\b|\bjob alert|\brecommended jobs|\bjobs for you\b/;

export interface Classification {
  /** The kind, when the rules are sure of it. */
  kind?: EmailKind;
  /** Every kind the email could be; empty when the rules know none. */
  kinds: EmailKind[];
  /** A job alert or recommendation, not about any application. */
  alert?: true;
}

/** Reads an email's subject and snippet for the kinds of email that move a card. */
export function classifyEmail(email: {
  subject: string;
  snippet?: string | undefined;
}): Classification {
  const text = `${email.subject} ${email.snippet ?? ""}`.toLowerCase().replace(/[’']/g, "'");
  if (ALERT_PATTERN.test(text)) return { kinds: [], alert: true };
  let kinds = EMAIL_KINDS.filter((kind) => KIND_PATTERNS[kind].test(text));
  // "Thank you for applying" comes with most later steps too; the later step is the news.
  if (kinds.length > 1) kinds = kinds.filter((kind) => kind !== "confirmation");
  const [only] = kinds;
  return kinds.length === 1 && only ? { kind: only, kinds } : { kinds };
}

/** Lowercase words without accents or punctuation: "Brainy Labs, Inc." is "brainy labs inc". */
function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "technologies",
  "technology",
  "labs",
  "group",
  "holdings",
]);

interface CompanyKeys {
  /** The ways the company's name can appear as words in an email. */
  names: string[];
  /** The ways it can appear as a domain label, without spaces. */
  labels: string[];
}

function companyKeys(company: string): CompanyKeys {
  const full = normalize(company);
  const words = full.split(" ");
  while (words.length > 1 && COMPANY_SUFFIXES.has(words.at(-1) ?? "")) words.pop();
  const short = words.join(" ");
  const names = [...new Set([full, short])].filter((name) => name.length >= 2);
  return { names, labels: [...new Set(names.map((name) => name.replace(/ /g, "")))] };
}

function containsWords(text: string, phrase: string): boolean {
  return ` ${normalize(text)} `.includes(` ${phrase} `);
}

/**
 * Application sites, assessment platforms and job sites that send email for many companies.
 * Their emails name the company in the sender's name or the subject instead of the domain.
 */
const RELAY_DOMAINS = new Set([
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "myworkdayjobs.com",
  "workday.com",
  "icims.com",
  "smartrecruiters.com",
  "jobvite.com",
  "successfactors.com",
  "successfactors.eu",
  "taleo.net",
  "oraclecloud.com",
  "bamboohr.com",
  "workable.com",
  "workablemail.com",
  "rippling.com",
  "gem.com",
  "paradox.ai",
  "eightfold.ai",
  "avature.net",
  "breezy.hr",
  "recruitee.com",
  "jazzhr.com",
  "applytojob.com",
  "hackerrank.com",
  "hackerrankforwork.com",
  "codesignal.com",
  "codility.com",
  "hirevue.com",
  "karat.com",
  "linkedin.com",
  "indeed.com",
  "indeedemail.com",
  "joinhandshake.com",
  "glassdoor.com",
  "wellfound.com",
  "simplify.jobs",
]);

/** The domain a site or mailbox belongs to: `mail.us.acme.com` is `acme.com`, `acme.co.uk` stays. */
function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  const keep = labels.length >= 3 && /^(co|com|ac|org|net|gov)$/.test(labels.at(-2) ?? "") ? 3 : 2;
  return labels.slice(-keep).join(".");
}

interface Sender {
  name: string;
  domain: string;
  /** The domain's labels before its suffix: `jobs.acme.com` has `jobs` and `acme`. */
  labels: string[];
  relay: boolean;
}

function parseSender(from: string): Sender {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const name = from.includes("<") ? from.slice(0, from.indexOf("<")).replace(/"/g, "").trim() : "";
  const domain = (address.split("@")[1] ?? "").trim().toLowerCase();
  const registrable = registrableDomain(domain);
  const suffixLabels = registrable.split(".").length - 1;
  const labels = domain.split(".").slice(0, -suffixLabels);
  return { name, domain, labels, relay: RELAY_DOMAINS.has(registrable) };
}

type Strength = "strong" | "weak";

/** How surely an email comes from or about the card's company, if at all. */
function matchStrength(email: Email, sender: Sender, card: Card): Strength | undefined {
  const keys = companyKeys(card.posting.company);
  if (!sender.relay) {
    if (sender.labels.some((label) => keys.labels.includes(label))) return "strong";
    let applyHost = "";
    try {
      applyHost = new URL(card.posting.applyUrl).hostname;
    } catch {
      // A card's apply URL is always valid; a bad one simply never matches.
    }
    const applySite = registrableDomain(applyHost);
    if (
      sender.domain &&
      !RELAY_DOMAINS.has(applySite) &&
      registrableDomain(sender.domain) === applySite
    ) {
      return "strong";
    }
  }
  const named = (text: string) => keys.names.some((name) => containsWords(text, name));
  if (sender.relay && (named(sender.name) || named(email.subject))) return "strong";
  if (named(sender.name) || named(email.subject) || named(email.snippet ?? "")) return "weak";
  return undefined;
}

const stageIndex = (stage: Stage) => STAGES.indexOf(stage);

/** Whether an email could move this card to `stage`: only forward, never out of Closed. */
function movesForward(card: Card, stage: EmailStage): boolean {
  return card.stage !== "closed" && stageIndex(stage) > stageIndex(card.stage);
}

/** Whether the email arrived while it can still be about this card. */
function inWindow(card: Card, email: Email): boolean {
  return Date.parse(email.receivedAt) >= Date.parse(card.queuedAt) - EMAIL_LOOKBACK_DAYS * DAY_MS;
}

function shortSubject(subject: string): string {
  const trimmed = subject.trim() || "(no subject)";
  return trimmed.length <= SUBJECT_MAX
    ? trimmed
    : `${trimmed.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

export interface GmailMove {
  emailId: string;
  postingId: string;
  company: string;
  title: string;
  from: Stage;
  to: EmailStage;
  /** The rules settled it, or Claude's judgment did. */
  by: "rules" | "judgment";
  evidence: EmailFacts;
}

export interface GmailReviewCard {
  postingId: string;
  company: string;
  title: string;
  stage: Stage;
}

/** An email the rules could not settle, for Claude to judge. */
export interface GmailReviewItem {
  emailId: string;
  from: string;
  receivedAt: string;
  subject: string;
  snippet?: string;
  /** The kinds the rules saw; empty when they saw none. */
  kinds: EmailKind[];
  why: string;
  /** The cards it could be about. */
  cards: GmailReviewCard[];
}

export interface GmailCounts {
  emails: number;
  /** Emails that already moved a card on an earlier Refresh. */
  alreadyRecorded: number;
  /** Job alerts and recommendations. */
  alerts: number;
  /** Emails from or about no company with a card. */
  unmatched: number;
  /** Emails about a card that would not move it forward. */
  noChange: number;
  /** Emails settled by Claude's judgment, moved or not. */
  judged: number;
}

export interface GmailPlan {
  /** Every card an email moved, as it ends up, by Posting id. */
  cards: Map<string, Card>;
  moves: GmailMove[];
  review: GmailReviewItem[];
  counts: GmailCounts;
}

export interface GmailInput {
  emails: readonly Email[];
  /** The cards on the board before this Refresh. */
  cards: readonly Card[];
  judgments: Readonly<Record<string, GmailJudgment>>;
  /** When the moves happen, as an ISO timestamp. */
  now: string;
}

/** Narrows several cards at one company to the one whose title the email names, if exactly one. */
function byTitle(email: Email, cards: Card[]): Card[] {
  const text = `${email.subject} ${email.snippet ?? ""}`;
  const named = cards.filter((card) => containsWords(text, normalize(card.posting.title)));
  return named.length === 1 ? named : cards;
}

/** Classifies each email, matches it to a card and decides the moves. Pure and deterministic. */
export function planGmailMoves(input: GmailInput): GmailPlan {
  const board = new Map(input.cards.map((card) => [card.postingId, card]));
  const moved = new Map<string, Card>();
  const moves: GmailMove[] = [];
  const review: GmailReviewItem[] = [];
  const counts: GmailCounts = {
    emails: input.emails.length,
    alreadyRecorded: 0,
    alerts: 0,
    unmatched: 0,
    noChange: 0,
    judged: 0,
  };

  const emails = [...input.emails].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
  );
  const move = (email: Email, card: Card, kind: EmailKind, by: GmailMove["by"]) => {
    const to = STAGE_OF_KIND[kind];
    if (!movesForward(card, to)) {
      counts.noChange += 1;
      return;
    }
    const evidence: EmailFacts = {
      company: card.posting.company,
      receivedAt: email.receivedAt,
      subject: shortSubject(email.subject),
    };
    const after = moveCardByEmail(card, to, evidence, input.now);
    board.set(card.postingId, after);
    moved.set(card.postingId, after);
    moves.push({
      emailId: email.id,
      postingId: card.postingId,
      company: card.posting.company,
      title: card.posting.title,
      from: card.stage,
      to,
      by,
      evidence,
    });
  };

  for (const email of emails) {
    const facts = { receivedAt: email.receivedAt, subject: shortSubject(email.subject) };
    if ([...board.values()].some((card) => hasEmail(card, facts))) {
      counts.alreadyRecorded += 1;
      continue;
    }

    const judgment = input.judgments[email.id];
    if (judgment) {
      counts.judged += 1;
      if ("ignore" in judgment) continue;
      const card = board.get(judgment.postingId);
      if (card) move(email, card, judgment.kind, "judgment");
      continue;
    }

    const classification = classifyEmail(email);
    if (classification.alert) {
      counts.alerts += 1;
      continue;
    }

    const sender = parseSender(email.from);
    const matches = [...board.values()]
      .map((card) => ({ card, strength: matchStrength(email, sender, card) }))
      .filter((m): m is { card: Card; strength: Strength } => m.strength !== undefined);
    if (matches.length === 0) {
      counts.unmatched += 1;
      continue;
    }
    const best: Strength = matches.some((m) => m.strength === "strong") ? "strong" : "weak";
    const kinds = classification.kinds.length > 0 ? classification.kinds : [...EMAIL_KINDS];
    const open = byTitle(
      email,
      matches
        .filter((m) => m.strength === best)
        .map((m) => m.card)
        .filter((card) => inWindow(card, email)),
    ).filter((card) => kinds.some((kind) => movesForward(card, STAGE_OF_KIND[kind])));
    if (open.length === 0) {
      counts.noChange += 1;
      continue;
    }

    const [only] = open;
    if (best === "strong" && open.length === 1 && only && classification.kind) {
      move(email, only, classification.kind, "rules");
      continue;
    }

    const company = open[0]?.posting.company ?? "";
    const why =
      best === "weak"
        ? `Only the subject or text names ${company}; the sender is not ${company} or an application site.`
        : open.length > 1
          ? `It could be about ${String(open.length)} cards at ${company}.`
          : classification.kinds.length > 1
            ? "It reads as more than one kind of email."
            : "The rules could not tell what kind of email it is.";
    const item: GmailReviewItem = {
      emailId: email.id,
      from: email.from,
      receivedAt: email.receivedAt,
      subject: email.subject,
      kinds: classification.kinds,
      why,
      cards: open.map((card) => ({
        postingId: card.postingId,
        company: card.posting.company,
        title: card.posting.title,
        stage: card.stage,
      })),
    };
    if (email.snippet !== undefined) item.snippet = email.snippet;
    review.push(item);
  }

  return { cards: moved, moves, review, counts };
}

export interface GmailSearchPlan {
  /** The first day searched, `YYYY-MM-DD` in UTC; undefined when there is nothing to search. */
  since: string | undefined;
  /** The companies with open cards, each once. */
  companies: string[];
  /** Gmail search queries that together cover every company. */
  queries: string[];
}

const KIND_TERMS =
  '(application OR applying OR applied OR interview OR assessment OR offer OR unfortunately OR candidacy OR "next steps")';

function searchTerm(company: string): string {
  const clean = company.replace(/"/g, "").trim();
  return /^[\p{L}\p{N}]+$/u.test(clean) ? clean : `"${clean}"`;
}

/** The Gmail searches that find replies about every card that is not Closed. */
export function gmailSearchPlan(cards: readonly Card[], now: string): GmailSearchPlan {
  const open = cards.filter((card) => card.stage !== "closed");
  if (open.length === 0) return { since: undefined, companies: [], queries: [] };
  const seen = new Set<string>();
  const companies: string[] = [];
  for (const card of open) {
    const key = normalize(card.posting.company);
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push(card.posting.company.trim());
  }
  const oldest = Math.min(...open.map((card) => Date.parse(card.queuedAt)));
  const start = Math.max(
    oldest - EMAIL_LOOKBACK_DAYS * DAY_MS,
    Date.parse(now) - MAX_SEARCH_DAYS * DAY_MS,
  );
  const since = new Date(start).toISOString().slice(0, 10);
  const queries: string[] = [];
  for (let i = 0; i < companies.length; i += COMPANIES_PER_QUERY) {
    const group = companies.slice(i, i + COMPANIES_PER_QUERY).map(searchTerm);
    queries.push(`after:${since.replace(/-/g, "/")} (${group.join(" OR ")}) ${KIND_TERMS}`);
  }
  return { since, companies, queries };
}

/** Submitted cards with no reply long enough to follow up, longest waiting first. */
export function followUps(cards: readonly Card[], now: string): Card[] {
  const at = Date.parse(now);
  return cards
    .filter((card) => needsFollowUp(card, at))
    .sort((a, b) => stageSince(a).localeCompare(stageSince(b)));
}
