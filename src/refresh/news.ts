/**
 * `jaa news plan|build <dir>`: the News Digest adapter, run by the Refresh skill after
 * `jaa refresh`, in the same `<dir>`.
 *
 * - `plan` computes the hiring signals from the Job List Refresh just wrote (`out/postings`, or
 *   `state/postings` when Refresh wrote none), lists the companies in the Queue (`state/cards`
 *   plus the new `out/cards`) and the sources the past week's digests (`state/news`) already
 *   linked, and writes them to `out/news-plan.json`.
 * - The skill then gathers forum highlights, company news and industry stories in chat and
 *   writes them to `out/news-gathered.json`.
 * - `build` joins the two into the day's News Digest, checks it against the dashboard contract,
 *   and writes `out/news/<day>.json` plus `out/news-writes.json`: one ArtifactData batch that
 *   sets the day's digest and removes digests past the days the dashboard keeps.
 */
import { join, resolve } from "node:path";
import {
  CARDS_COLLECTION,
  NEWS_COLLECTION,
  NEWS_DAYS_KEPT,
  POSTINGS_COLLECTION,
  validateCardDocument,
  validateNewsDocument,
  validatePostingsDocument,
  type Card,
  type JobListMeta,
  type JobListPage,
  type NewsDigest,
  type Posting,
} from "../contract/index.ts";
import { buildDigest, dayIn, planNews, staleNewsDays, type NewsPlan } from "../engine/news.ts";
import { readForums, type ForumRead } from "./forums.ts";
import {
  RefreshError,
  batchesOf,
  readJson,
  savedIds,
  type BatchWrite,
  type RefreshIo,
} from "./run.ts";

export interface NewsIo extends RefreshIo {
  /** The Candidate's time zone, which decides the digest's day. */
  timeZone(): string;
  sleep(ms: number): Promise<void>;
}

/** What `jaa news plan` writes: the engine's plan plus the forums' threads to pick from. */
export interface NewsPlanFile extends NewsPlan {
  forums: ForumRead[];
}

export type NewsStep = "plan" | "build";

const PLAN_FILE = "news-plan.json";
const GATHERED_FILE = "news-gathered.json";
const WRITES_FILE = "news-writes.json";

const number = (n: number) => n.toLocaleString("en-US");
const count = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

function longDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Every document in a saved collection folder that passes `validate`, by id. */
async function readValid<T>(
  io: RefreshIo,
  folder: string,
  validate: (docId: string, input: unknown) => { ok: boolean; value?: unknown },
): Promise<Map<string, T>> {
  const docs = new Map<string, T>();
  for (const docId of await savedIds(io, folder)) {
    const result = validate(docId, await readJson(io, join(folder, `${docId}.json`)));
    if (result.ok) docs.set(docId, result.value as T);
  }
  return docs;
}

/** The Job List in a saved postings folder: the pages of the Refresh its meta document names. */
async function readJobList(io: RefreshIo, folder: string): Promise<Posting[] | undefined> {
  const docs = await readValid<JobListMeta | JobListPage>(io, folder, validatePostingsDocument);
  const meta = docs.get("meta") as JobListMeta | undefined;
  if (!meta) return undefined;
  return [...docs.entries()]
    .filter(([id]) => id !== "meta")
    .map(([, doc]) => doc as JobListPage)
    .filter((page) => page.refreshedAt === meta.refreshedAt)
    .sort((a, b) => a.page - b.page)
    .flatMap((page) => page.postings);
}

async function plan(dir: string, io: NewsIo): Promise<void> {
  const day = dayIn(io.now(), io.timeZone());
  const postings =
    (await readJobList(io, join(dir, "out", POSTINGS_COLLECTION))) ??
    (await readJobList(io, join(dir, "state", POSTINGS_COLLECTION))) ??
    [];
  const cards = new Map<string, Card>();
  for (const folder of [join(dir, "state", CARDS_COLLECTION), join(dir, "out", CARDS_COLLECTION)]) {
    for (const [id, card] of await readValid<Card>(io, folder, validateCardDocument)) {
      cards.set(id, card);
    }
  }
  const recent = await readValid<NewsDigest>(
    io,
    join(dir, "state", NEWS_COLLECTION),
    validateNewsDocument,
  );
  const forums = await readForums({ fetch: io.fetch, sleep: (ms) => io.sleep(ms) });
  const result: NewsPlanFile = {
    ...planNews({ day, postings, cards: [...cards.values()], recent: [...recent.values()] }),
    forums,
  };

  const out = join(dir, "out");
  await io.makeDir(out);
  const planPath = join(out, PLAN_FILE);
  await io.writeFile(planPath, `${JSON.stringify(result, null, 2)}\n`);

  const lines = [`News Digest for ${longDay(day)}.`];
  lines.push(`Job List: ${count(result.newThisWeek, "Posting")} went up in the past 7 days.`);
  lines.push(
    result.hiringSignals.length === 0
      ? "Hiring signals: none this week."
      : `Hiring signals: ${count(result.hiringSignals.length, "company", "companies")} (${result.hiringSignals
          .map((s) => `${s.company}, ${count(s.newPostings, "new Posting")}`)
          .join("; ")}).`,
  );
  lines.push(
    result.queueCompanies.length === 0
      ? "Companies in the Queue: none, so leave companyNews empty."
      : `Companies in the Queue: ${result.queueCompanies.join(", ")}.`,
  );
  lines.push("Forums:");
  for (const read of forums) {
    lines.push(
      read.ok
        ? `- ${read.forum}: ${count(read.threads.length, "thread")}, under forums in ${planPath}.`
        : `- ${read.forum}: FAILED. ${read.error}`,
    );
  }
  if (result.recentUrls.length > 0) {
    lines.push(
      `Already linked this week: ${count(result.recentUrls.length, "source")}, listed under recentUrls in ${planPath}; do not repeat them.`,
    );
  }
  lines.push(`Next: gather the news and write it to ${join(out, GATHERED_FILE)}.`);
  io.stdout(`${lines.join("\n")}\n`);
}

function isPlan(value: unknown): value is NewsPlan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Partial<NewsPlan>;
  return (
    typeof plan.day === "string" &&
    typeof plan.newThisWeek === "number" &&
    Array.isArray(plan.hiringSignals) &&
    Array.isArray(plan.queueCompanies) &&
    Array.isArray(plan.recentUrls)
  );
}

async function build(dir: string, io: NewsIo): Promise<void> {
  const out = join(dir, "out");
  const planJson = await readJson(io, join(out, PLAN_FILE));
  if (!isPlan(planJson)) {
    throw new RefreshError(
      `No News Digest plan at ${join(out, PLAN_FILE)}. Run jaa news plan first.`,
    );
  }
  const gatheredPath = join(out, GATHERED_FILE);
  const gathered = await readJson(io, gatheredPath);
  if (gathered === undefined) {
    throw new RefreshError(
      `No gathered news at ${gatheredPath}. Write the forum highlights, company news and industry stories there first.`,
    );
  }
  const result = buildDigest(planJson, gathered, io.now());
  if (!result.ok) {
    throw new RefreshError(
      [
        `The News Digest in ${gatheredPath} does not match the dashboard contract:`,
        ...result.issues.map((issue) => `- ${issue}`),
        "Fix those entries and run jaa news build again.",
      ].join("\n"),
    );
  }
  const digest = result.value;

  const versions = await readJson(io, join(dir, "versions.json"));
  const versionOf = (docId: string): number | undefined => {
    const version =
      typeof versions === "object" && versions !== null
        ? (versions as Record<string, unknown>)[`${NEWS_COLLECTION}/${docId}`]
        : undefined;
    return Number.isInteger(version) && (version as number) > 0 ? (version as number) : undefined;
  };

  await io.makeDir(join(out, NEWS_COLLECTION));
  const filePath = join(out, NEWS_COLLECTION, `${digest.day}.json`);
  const text = `${JSON.stringify(digest)}\n`;
  await io.writeFile(filePath, text);
  const set: BatchWrite = {
    op: "set",
    collection: NEWS_COLLECTION,
    doc_id: digest.day,
    file_path: filePath,
  };
  const setVersion = versionOf(digest.day);
  if (setVersion !== undefined) set.if_version = setVersion;
  const writes = [{ write: set, bytes: Buffer.byteLength(text) }];

  const stale = staleNewsDays(await savedIds(io, join(dir, "state", NEWS_COLLECTION)), digest.day);
  for (const day of stale) {
    const remove: BatchWrite = { op: "delete", collection: NEWS_COLLECTION, doc_id: day };
    const version = versionOf(day);
    if (version !== undefined) remove.if_version = version;
    writes.push({ write: remove, bytes: 0 });
  }
  const batches = batchesOf(writes);
  const writesPath = join(out, WRITES_FILE);
  await io.writeFile(writesPath, `${JSON.stringify({ batches }, null, 2)}\n`);

  const lines = [
    `News Digest for ${longDay(digest.day)}: ${count(digest.hiringSignals.length, "hiring signal")}, ${count(digest.forumHighlights.length, "forum highlight")}, ${count(digest.companyNews.length, "company news item")}, ${count(digest.industryNews.length, "industry story", "industry stories")}.`,
  ];
  for (const gap of digest.gaps) lines.push(`Gap in ${gap.section}: ${gap.note}`);
  if (stale.length > 0) {
    lines.push(
      `Removing ${count(stale.length, "digest")} older than ${String(NEWS_DAYS_KEPT)} days.`,
    );
  }
  lines.push(
    `Next: send the ${batches.length === 1 ? "batch" : `${String(batches.length)} batches`} in ${writesPath} with ArtifactData, one batch call each, in order.`,
  );
  io.stdout(`${lines.join("\n")}\n`);
}

/** Runs one News Digest step and resolves the exit code. */
export async function runNewsCommand(step: NewsStep, dirArg: string, io: NewsIo): Promise<number> {
  const dir = resolve(dirArg);
  try {
    await (step === "plan" ? plan(dir, io) : build(dir, io));
    return 0;
  } catch (error) {
    if (error instanceof RefreshError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
