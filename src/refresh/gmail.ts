/**
 * `jaa gmail plan|match <dir>`: the Gmail Stage tracking adapter, run by the Refresh skill after
 * the Job List is written, in the same `<dir>`.
 *
 * - `plan` reads the settings and cards saved under `state/`, and writes `out/gmail-plan.json`:
 *   whether the Candidate opted in, and the Gmail searches that cover every open card. It also
 *   lists the Submitted cards due a follow-up, whether or not Gmail is read.
 * - The skill runs the searches read-only with the Candidate's Gmail connector and saves what it
 *   finds to `out/gmail-gathered.json` as `{ "emails": [...] }`.
 * - `match` classifies the emails and matches them to cards, applies the skill's judgments from
 *   `gmail-judgments.json` (kept between runs), and writes the moved cards to `out/gmail-cards/`,
 *   their ArtifactData batches to `out/gmail-writes.json` and the unsure emails to
 *   `out/gmail-review.json`. Moved cards keep only each email's company, date and subject.
 */
import { join, resolve } from "node:path";
import * as z from "zod/mini";
import {
  CARDS_COLLECTION,
  FOLLOW_UP_DAYS,
  stageSince,
  validateCardDocument,
  validateSettings,
  type Card,
  type Settings,
  type Stage,
} from "../contract/index.ts";
import { validateWith } from "../contract/validation.ts";
import {
  emailSchema,
  followUps,
  gmailJudgmentSchema,
  gmailSearchPlan,
  planGmailMoves,
  type GmailJudgment,
  type GmailSearchPlan,
} from "../engine/gmail.ts";
import type { NewsIo } from "./news.ts";
import { RefreshError, batchesOf, readJson, savedIds, type BatchWrite } from "./run.ts";

export type GmailStep = "plan" | "match";

/** What `jaa gmail plan` writes: whether to read Gmail, and the searches that cover the board. */
export interface GmailPlanFile extends GmailSearchPlan {
  /** "unset" until the Candidate chooses in Setup, which counts as off. */
  tracking: "on" | "off" | "unset";
}

const PLAN_FILE = "gmail-plan.json";
const GATHERED_FILE = "gmail-gathered.json";
const REVIEW_FILE = "gmail-review.json";
const WRITES_FILE = "gmail-writes.json";
const JUDGMENTS_FILE = "gmail-judgments.json";
const CARDS_FOLDER = "gmail-cards";

const STAGE_NAMES: Record<Stage, string> = {
  queued: "Queued",
  ready_for_review: "Ready for Review",
  submitted: "Submitted",
  interviewing: "Interviewing",
  offer: "Offer",
  closed: "Closed",
};

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

async function readSettings(io: NewsIo, dir: string): Promise<Settings> {
  const path = join(dir, "state", "settings", "main.json");
  const json = await readJson(io, path);
  if (json === undefined) {
    throw new RefreshError(
      `No settings at ${path}. Read settings/main from the dashboard into ${join(dir, "state")} first.`,
    );
  }
  const settings = validateSettings(json);
  if (!settings.ok) {
    throw new RefreshError(
      `The settings document does not match the dashboard contract:\n${settings.issues.map((i) => `- ${i}`).join("\n")}`,
    );
  }
  return settings.value;
}

async function readCards(io: NewsIo, dir: string): Promise<Card[]> {
  const folder = join(dir, "state", CARDS_COLLECTION);
  const cards: Card[] = [];
  for (const docId of await savedIds(io, folder)) {
    const result = validateCardDocument(docId, await readJson(io, join(folder, `${docId}.json`)));
    if (result.ok) cards.push(result.value as Card);
  }
  return cards;
}

function day(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

function followUpLines(cards: readonly Card[], now: string, timeZone: string): string[] {
  const due = followUps(cards, now);
  if (due.length === 0) return ["Follow up: none."];
  return [
    `Follow up: ${count(due.length, "Submitted card has", "Submitted cards have")} had no reply in ${String(FOLLOW_UP_DAYS)} days or more:`,
    ...due.map(
      (card) =>
        `- ${card.posting.company}, ${card.posting.title}: Submitted since ${day(stageSince(card), timeZone)}.`,
    ),
  ];
}

async function plan(dir: string, io: NewsIo): Promise<void> {
  const settings = await readSettings(io, dir);
  const cards = await readCards(io, dir);
  const tracking: GmailPlanFile["tracking"] =
    settings.gmailTracking === undefined ? "unset" : settings.gmailTracking ? "on" : "off";
  const search: GmailSearchPlan =
    tracking === "on"
      ? gmailSearchPlan(cards, io.now())
      : { since: undefined, companies: [], queries: [] };
  const out = join(dir, "out");
  await io.makeDir(out);
  const file: GmailPlanFile = { tracking, ...search };
  await io.writeFile(join(out, PLAN_FILE), `${JSON.stringify(file, null, 2)}\n`);

  const lines: string[] = [];
  if (tracking === "off") {
    lines.push("Gmail tracking is off, so skip reading Gmail.");
  } else if (tracking === "unset") {
    lines.push(
      "The Candidate has not chosen whether Refresh reads their Gmail, so skip reading Gmail. Mention that /job-app-assist:setup can switch Gmail tracking on.",
    );
  } else if (search.queries.length === 0) {
    lines.push("Gmail tracking is on, but no card is open, so there is nothing to search for.");
  } else {
    lines.push(
      `Gmail tracking is on. Search the Candidate's Gmail, read-only, with ${search.queries.length === 1 ? "this query" : `these ${String(search.queries.length)} queries`} (emails since ${search.since ?? ""}, about ${count(search.companies.length, "company", "companies")}):`,
      ...search.queries.map((query) => `- ${query}`),
      `Next: save the emails found to ${join(out, GATHERED_FILE)}, then run jaa gmail match.`,
    );
  }
  lines.push(...followUpLines(cards, io.now(), io.timeZone()));
  io.stdout(`${lines.join("\n")}\n`);
}

const gatheredSchema = z.strictObject({ emails: z.array(emailSchema) });

async function readJudgments(
  io: NewsIo,
  path: string,
  board: ReadonlyMap<string, Card>,
): Promise<Record<string, GmailJudgment>> {
  const json = await readJson(io, path);
  if (json === undefined) return {};
  const shape =
    'It maps Gmail message ids to { "postingId": "<card>", "kind": "<kind>" } or { "ignore": true }.';
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new RefreshError(`${path} is not a JSON object. ${shape}`);
  }
  const judgments: Record<string, GmailJudgment> = {};
  for (const [id, entry] of Object.entries(json)) {
    const result = validateWith(gmailJudgmentSchema, entry);
    if (!result.ok) {
      throw new RefreshError(`${path} gives ${id} ${result.issues.join("; ")}. ${shape}`);
    }
    const judgment = result.value;
    if ("postingId" in judgment && !board.has(judgment.postingId)) {
      throw new RefreshError(
        `${path}: ${id} names the card ${judgment.postingId}, which is not on the board. Use a postingId from ${REVIEW_FILE}.`,
      );
    }
    judgments[id] = judgment;
  }
  return judgments;
}

async function match(dir: string, io: NewsIo): Promise<void> {
  const settings = await readSettings(io, dir);
  if (settings.gmailTracking !== true) {
    throw new RefreshError(
      "Gmail tracking is off in the Candidate's settings, so Refresh does not read their Gmail.",
    );
  }
  const cards = await readCards(io, dir);
  const board = new Map(cards.map((card) => [card.postingId, card]));
  const out = join(dir, "out");
  const gatheredPath = join(out, GATHERED_FILE);
  const gatheredJson = await readJson(io, gatheredPath);
  if (gatheredJson === undefined) {
    throw new RefreshError(
      `No emails at ${gatheredPath}. Save what the Gmail searches found there first, as { "emails": [...] }.`,
    );
  }
  const gathered = validateWith(gatheredSchema, gatheredJson);
  if (!gathered.ok) {
    throw new RefreshError(
      [
        `The emails in ${gatheredPath} are not in the expected shape:`,
        ...gathered.issues.map((issue) => `- ${issue}`),
        "Each email is { id, from, receivedAt, subject, snippet }; fix them and run jaa gmail match again.",
      ].join("\n"),
    );
  }
  const { emails } = gathered.value;
  const judgmentsPath = join(dir, JUDGMENTS_FILE);
  const judgments = await readJudgments(io, judgmentsPath, board);
  const versions = await readJson(io, join(dir, "versions.json"));
  const versionOf = (docId: string): number | undefined => {
    const version =
      typeof versions === "object" && versions !== null
        ? (versions as Record<string, unknown>)[`${CARDS_COLLECTION}/${docId}`]
        : undefined;
    return Number.isInteger(version) && (version as number) > 0 ? (version as number) : undefined;
  };

  const now = io.now();
  const result = planGmailMoves({ emails, cards, judgments, now });

  const missing = [...result.cards.keys()].filter((id) => versionOf(id) === undefined).sort();
  if (missing.length > 0) {
    throw new RefreshError(
      `versions.json has no version for ${missing.map((id) => `${CARDS_COLLECTION}/${id}`).join(", ")}. Add the version ArtifactData reported for each card read.`,
    );
  }

  await io.removeDir(join(out, CARDS_FOLDER));
  await io.makeDir(join(out, CARDS_FOLDER));
  const writes: { write: BatchWrite; bytes: number }[] = [];
  for (const [docId, card] of [...result.cards].sort(([a], [b]) => a.localeCompare(b))) {
    const check = validateCardDocument(docId, card);
    if (!check.ok) {
      throw new RefreshError(
        `Gmail tracking built an invalid ${CARDS_COLLECTION}/${docId}:\n${check.issues.map((i) => `- ${i}`).join("\n")}`,
      );
    }
    const filePath = join(out, CARDS_FOLDER, `${docId}.json`);
    const text = `${JSON.stringify(card)}\n`;
    await io.writeFile(filePath, text);
    const write: BatchWrite = {
      op: "set",
      collection: CARDS_COLLECTION,
      doc_id: docId,
      file_path: filePath,
    };
    // Every moved card has a version: the check above stops the run otherwise.
    const version = versionOf(docId);
    if (version !== undefined) write.if_version = version;
    writes.push({ write, bytes: Buffer.byteLength(text) });
  }
  const batches = batchesOf(writes);
  const writesPath = join(out, WRITES_FILE);
  await io.writeFile(writesPath, `${JSON.stringify({ batches }, null, 2)}\n`);
  const reviewPath = join(out, REVIEW_FILE);
  await io.writeFile(reviewPath, `${JSON.stringify({ review: result.review }, null, 2)}\n`);

  // Keep only judgments about emails the searches still find, so the file does not grow forever.
  const found = new Set(emails.map((email) => email.id));
  const kept = Object.fromEntries(Object.entries(judgments).filter(([id]) => found.has(id)));
  if (Object.keys(kept).length !== Object.keys(judgments).length) {
    await io.writeFile(judgmentsPath, `${JSON.stringify(kept, null, 2)}\n`);
  }

  const timeZone = io.timeZone();
  const { counts } = result;
  const lines = [
    `Gmail: read ${count(counts.emails, "email")}; ${String(counts.alreadyRecorded)} already used on an earlier Refresh, ${String(counts.alerts)} job alerts, ${String(counts.unmatched)} about no card on the board, ${String(counts.noChange)} with no forward move.`,
  ];
  if (result.moves.length === 0) {
    lines.push("Moved no cards.");
  } else {
    lines.push(`Moved ${count(result.moves.length, "card")}:`);
    for (const move of result.moves) {
      lines.push(
        `- ${move.company}, ${move.title}: ${STAGE_NAMES[move.from]} to ${STAGE_NAMES[move.to]}${move.to === "closed" ? " (rejected)" : ""}, by "${move.evidence.subject}" (${day(move.evidence.receivedAt, timeZone)}).`,
      );
    }
  }
  if (result.review.length > 0) {
    lines.push(
      `Unsure: ${count(result.review.length, "email")} for you to judge, listed in ${reviewPath}.`,
    );
  }
  const after = cards.map((card) => result.cards.get(card.postingId) ?? card);
  lines.push(...followUpLines(after, now, timeZone));
  lines.push(
    batches.length === 0
      ? "Nothing to write to the dashboard."
      : `Next: send the ${batches.length === 1 ? "batch" : `${String(batches.length)} batches`} in ${writesPath} with ArtifactData, one batch call each, in order.`,
  );
  io.stdout(`${lines.join("\n")}\n`);
}

/** Runs one Gmail Stage tracking step and resolves the exit code. */
export async function runGmailCommand(
  step: GmailStep,
  dirArg: string,
  io: NewsIo,
): Promise<number> {
  const dir = resolve(dirArg);
  try {
    await (step === "plan" ? plan(dir, io) : match(dir, io));
    return 0;
  } catch (error) {
    if (error instanceof RefreshError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
