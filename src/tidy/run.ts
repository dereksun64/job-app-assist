/**
 * `jaa tidy plan|build <dir>`: makes room in a full dashboard database. The Tidy skill saves the
 * whole dashboard state into `<dir>/state` with ArtifactData (the skill uses
 * `.job-app-assist/tidy`). `plan` decides what history can go (see engine/tidy.ts), prints it for
 * the Candidate to approve and saves it to `<dir>/out/tidy-plan.json`; nothing is removed then.
 * After the Candidate approves, the skill saves the version of each listed document in
 * `<dir>/versions.json`, and `build` turns the plan into pinned ArtifactData delete batches in
 * `<dir>/out/writes.json`, so a document the Candidate changed meanwhile is never removed.
 */
import { join } from "node:path";
import {
  CARDS_COLLECTION,
  NEWS_COLLECTION,
  POSTINGS_COLLECTION,
  SKIPS_COLLECTION,
  APPLICATIONS_COLLECTION,
  REFERRALS_COLLECTION,
  VARIANT_OVERRIDES_COLLECTION,
  validateCardDocument,
  validatePostingsDocument,
  validateSkipDocument,
  type Card,
  type JobListMeta,
  type JobListPage,
} from "../contract/index.ts";
import { dayIn } from "../engine/news.ts";
import { CLOSED_KEPT_DAYS, planTidy, type TidyDelete } from "../engine/tidy.ts";
import { batchesOf, type BatchWrite } from "../refresh/run.ts";

export interface TidyIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** The names in a directory, or none when it does not exist. */
  readDir(path: string): Promise<string[]>;
  makeDir(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  /** The size in bytes of a regular file, or undefined when there is none at `path`. */
  fileSize(path: string): Promise<number | undefined>;
  now(): string;
  timeZone(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const TIDY_USAGE = `       jaa tidy plan <dir> [--closed-days <days>]
       jaa tidy build <dir>`;

const PLAN_FILE = "tidy-plan.json";
const NAMES_SHOWN = 15;

class TidyError extends Error {}

const number = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

async function readJson(io: TidyIo, path: string): Promise<unknown> {
  try {
    return JSON.parse(await io.readFile(path)) as unknown;
  } catch {
    return undefined;
  }
}

async function ids(io: TidyIo, folder: string): Promise<string[]> {
  return (await io.readDir(folder))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

async function readCards(io: TidyIo, state: string): Promise<Card[]> {
  const folder = join(state, CARDS_COLLECTION);
  const cards: Card[] = [];
  for (const id of await ids(io, folder)) {
    const result = validateCardDocument(id, await readJson(io, join(folder, `${id}.json`)));
    if (result.ok) cards.push(result.value as Card);
  }
  return cards;
}

async function readSkips(io: TidyIo, state: string) {
  const folder = join(state, SKIPS_COLLECTION);
  const skips: { postingId: string; skippedAt: string }[] = [];
  for (const id of await ids(io, folder)) {
    const result = validateSkipDocument(id, await readJson(io, join(folder, `${id}.json`)));
    if (result.ok) {
      const { postingId, skippedAt } = result.value as { postingId: string; skippedAt: string };
      skips.push({ postingId, skippedAt });
    }
  }
  return skips;
}

/** The Posting ids in the current Job List: the pages that match the meta document. */
async function readJobList(io: TidyIo, state: string): Promise<string[]> {
  const folder = join(state, POSTINGS_COLLECTION);
  let meta: JobListMeta | undefined;
  const pages: JobListPage[] = [];
  for (const id of await ids(io, folder)) {
    const result = validatePostingsDocument(id, await readJson(io, join(folder, `${id}.json`)));
    if (!result.ok) continue;
    if (id === "meta") meta = result.value as JobListMeta;
    else pages.push(result.value as JobListPage);
  }
  return pages
    .filter((page) => !meta || page.refreshedAt === meta.refreshedAt)
    .flatMap((page) => page.postings.map((p) => p.id));
}

async function plan(io: TidyIo, dir: string, closedDays: number): Promise<void> {
  const state = join(dir, "state");
  const collections = await io.readDir(state);
  let documentCount = 0;
  for (const collection of collections)
    documentCount += (await ids(io, join(state, collection))).length;
  if (documentCount === 0) {
    throw new TidyError(
      `${state} holds no documents. Save the dashboard state there with ArtifactData first.`,
    );
  }

  const cards = await readCards(io, state);
  const valid = new Set(cards.map((c) => c.postingId));
  const result = planTidy(
    {
      cards,
      unreadableCards: (await ids(io, join(state, CARDS_COLLECTION))).filter(
        (id) => !valid.has(id),
      ),
      applications: await ids(io, join(state, APPLICATIONS_COLLECTION)),
      referrals: await ids(io, join(state, REFERRALS_COLLECTION)),
      variantOverrides: await ids(io, join(state, VARIANT_OVERRIDES_COLLECTION)),
      skips: await readSkips(io, state),
      newsDays: await ids(io, join(state, NEWS_COLLECTION)),
      jobList: await readJobList(io, state),
      documentCount,
    },
    io.now(),
    { closedDays, today: dayIn(io.now(), io.timeZone()) },
  );

  const out = join(dir, "out");
  await io.removeDir(out);
  await io.makeDir(out);
  const deletes: TidyDelete[] = result.deletes;
  await io.writeFile(join(out, PLAN_FILE), `${JSON.stringify({ deletes }, null, 2)}\n`);

  if (deletes.length === 0) {
    io.stdout(
      [
        `Nothing to remove: the dashboard holds ${plural(documentCount, "document")}, and none is old history Tidy removes.`,
        `To make room, the Candidate can move cards they no longer need to Closed and run Tidy with --closed-days 0, which removes every Closed card now.`,
        "",
      ].join("\n"),
    );
    return;
  }

  let bytes = 0;
  for (const { collection, docId } of deletes) {
    bytes += (await io.fileSize(join(state, collection, `${docId}.json`))) ?? 0;
  }
  const closed = cards.filter((c) =>
    deletes.some((d) => d.collection === CARDS_COLLECTION && d.docId === c.postingId),
  );
  const lines = [
    `Tidy would remove ${plural(deletes.length, "document")} (about ${number(Math.max(1, Math.round(bytes / 1024)))} KB): ${number(documentCount)} documents now, ${number(result.documentsAfter)} after.`,
  ];
  if (result.closedCards > 0) {
    lines.push(
      `- Closed cards closed ${String(closedDays)} or more days ago: ${number(result.closedCards)}, with their answers, Referral Drafts and Resume Variant choices.`,
    );
    for (const c of closed.slice(0, NAMES_SHOWN)) {
      lines.push(`  - ${c.posting.company}, ${c.posting.title} (${c.closedReason ?? "closed"})`);
    }
    if (closed.length > NAMES_SHOWN)
      lines.push(`  - and ${number(closed.length - NAMES_SHOWN)} more`);
  }
  if (result.leftovers > 0) {
    lines.push(
      `- Answers, Referral Drafts and Resume Variant choices for Postings that have no card and have left the Job List: ${number(result.leftovers)}.`,
    );
  }
  if (result.oldSkips > 0) {
    lines.push(
      `- Skips older than 180 days whose Posting has left the Job List: ${number(result.oldSkips)}.`,
    );
  }
  if (result.oldDigests > 0) {
    lines.push(`- News Digests older than 90 days: ${number(result.oldDigests)}.`);
  }
  lines.push(
    "Open cards, settings, Sources and the Job List stay. Nothing is removed until the Candidate approves this list.",
    `Saved the list to ${join(out, PLAN_FILE)}.`,
    "",
  );
  io.stdout(lines.join("\n"));
}

async function build(io: TidyIo, dir: string): Promise<void> {
  const planPath = join(dir, "out", PLAN_FILE);
  const saved = (await readJson(io, planPath)) as { deletes?: TidyDelete[] } | undefined;
  if (!Array.isArray(saved?.deletes)) {
    throw new TidyError(`${planPath} is missing. Run jaa tidy plan ${dir} first.`);
  }
  const versions = ((await readJson(io, join(dir, "versions.json"))) ?? {}) as Record<
    string,
    unknown
  >;
  const missing: string[] = [];
  const writes: { write: BatchWrite; bytes: number }[] = [];
  for (const { collection, docId } of saved.deletes) {
    const version = versions[`${collection}/${docId}`];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      missing.push(`${collection}/${docId}`);
      continue;
    }
    writes.push({
      write: { op: "delete", collection, doc_id: docId, if_version: version },
      bytes: 0,
    });
  }
  if (missing.length > 0) {
    throw new TidyError(
      `${join(dir, "versions.json")} has no version for:\n${missing.map((m) => `- ${m}`).join("\n")}\nAdd the version ArtifactData reported for each.`,
    );
  }
  const batches = batchesOf(writes);
  const writesPath = join(dir, "out", "writes.json");
  await io.writeFile(writesPath, `${JSON.stringify({ batches }, null, 2)}\n`);
  io.stdout(
    `Send the ${plural(batches.length, "batch", "batches")} in ${writesPath} with ArtifactData, in order: ${plural(writes.length, "removal")}.\n`,
  );
}

/** Runs `jaa tidy <step> ...` and resolves its exit code. */
export async function runTidy(argv: readonly string[], io: TidyIo): Promise<number> {
  const [step, dir, ...rest] = argv;
  const usage = () => {
    io.stderr(`Usage:\n${TIDY_USAGE}\n`);
    return 2;
  };
  if (!dir || dir.startsWith("--")) return usage();
  try {
    if (step === "plan") {
      let closedDays = CLOSED_KEPT_DAYS;
      if (rest.length === 2 && rest[0] === "--closed-days") {
        closedDays = Number(rest[1]);
        if (!Number.isInteger(closedDays) || closedDays < 0) return usage();
      } else if (rest.length > 0) return usage();
      await plan(io, dir, closedDays);
    } else if (step === "build" && rest.length === 0) {
      await build(io, dir);
    } else {
      return usage();
    }
    return 0;
  } catch (error) {
    if (error instanceof TidyError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
