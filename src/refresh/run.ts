/**
 * `jaa refresh <dir>`: the Refresh adapter. It reads the dashboard state the Refresh skill saved
 * under `<dir>/state` (ArtifactData reads with `out_dir`), fetches the Job Feed, resolves short
 * links, runs the deterministic engine, validates every document, and writes the documents plus
 * ready-to-send ArtifactData batches under `<dir>/out`.
 *
 * Layout of `<dir>`:
 * - state/settings/main.json, state/sources/<doc-id>.json, state/postings/<doc-id>.json,
 *   state/cards/<doc-id>.json, state/skips/<doc-id>.json: the current dashboard documents
 *   (a missing Source document means that Source has its default).
 * - versions.json: `{ "postings/<doc-id>": <version> }` for every postings document read.
 * - short-links.json: short links resolved on earlier Refreshes (kept between runs).
 * - variant-judgments.json: the Refresh skill's calls on unsure Resume Variant picks, by Posting
 *   id (kept between runs, so each Posting is reviewed once).
 * - out/postings/<doc-id>.json, out/cards/<doc-id>.json, out/writes.json, out/summary.json: what
 *   this run produced. Refresh only creates cards, so card writes carry no version.
 * - out/variant-review.json: unsure Resume Variant picks for the Refresh skill to review.
 * - out/sources.json: what each Source gave, so `--rerun` can rebuild without the network.
 */
import { join, resolve } from "node:path";
import {
  ADDED_BY_URL_SOURCE,
  CARDS_COLLECTION,
  JOB_FEED_SOURCE,
  POSSIBLY_CLOSED_DAYS,
  POSTINGS_COLLECTION,
  SKIPS_COLLECTION,
  SOURCES_COLLECTION,
  WATCHLIST_SOURCE,
  readSourceSettings,
  validateCardDocument,
  validateDocument,
  validatePostingsDocument,
  validateSettings,
  type Card,
  type JobListMeta,
  type JobListPage,
  type SourceSettings,
} from "../contract/index.ts";
import type { CurrentQueue } from "../engine/queue.ts";
import {
  runRefresh,
  shortLinksToResolve,
  MAX_JUDGMENT_REASON,
  type CurrentJobList,
  type RefreshSummary,
  type VariantJudgment,
} from "../engine/refresh.ts";
import type { SourceResult } from "../engine/source.ts";
import { readWatchlist } from "./job-boards.ts";
import { parseJobFeed, readJobFeed, type Fetch } from "./job-feed.ts";
import { resolveShortLinks } from "./short-links.ts";

export interface RefreshIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  /** File names in a directory, or an empty list when it does not exist. */
  readDir(path: string): Promise<string[]>;
  makeDir(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  fetch: Fetch;
  now(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface RefreshOptions {
  /** Read the Job Feed from this URL or file instead of the published feed. */
  feed?: string;
  /**
   * Rebuild from the Sources and short links the last run saved, reading nothing from the
   * network; used after the Refresh skill records new Resume Variant judgments.
   */
  rerun?: boolean;
}

/** One entry of an ArtifactData `batch` call's `writes`. */
export interface BatchWrite {
  op: "set" | "delete";
  collection: string;
  doc_id: string;
  file_path?: string;
  if_version?: number;
}

/** ArtifactData limits: 50 writes and 1 MiB per batch; stay well under the size limit. */
const BATCH_MAX_WRITES = 50;
const BATCH_MAX_BYTES = 900 * 1024;

/** A problem the skill can fix; the CLI prints its message and exits 1. */
export class RefreshError extends Error {}

export async function readJson(io: RefreshIo, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RefreshError(`${path} is not valid JSON.`);
  }
}

interface State {
  current: CurrentJobList;
  /** Every postings document id found in the state, valid or not. */
  existing: string[];
}

async function readState(io: RefreshIo, dir: string): Promise<State> {
  const folder = join(dir, "state", POSTINGS_COLLECTION);
  const files = (await io.readDir(folder)).filter((name) => name.endsWith(".json")).sort();
  const existing: string[] = [];
  let meta: JobListMeta | undefined;
  const pages: JobListPage[] = [];
  for (const file of files) {
    const docId = file.slice(0, -".json".length);
    existing.push(docId);
    const result = validatePostingsDocument(docId, await readJson(io, join(folder, file)));
    if (!result.ok) continue;
    if (docId === "meta") meta = result.value as JobListMeta;
    else pages.push(result.value as JobListPage);
  }
  // Only pages from the Refresh the meta document describes are the current Job List.
  const consistent = meta ? pages.filter((page) => page.refreshedAt === meta.refreshedAt) : pages;
  const current: CurrentJobList = { pages: consistent.sort((a, b) => a.page - b.page) };
  if (meta) current.meta = meta;
  return { current, existing };
}

/** The ids of the JSON documents saved for one collection. */
export async function savedIds(io: RefreshIo, folder: string): Promise<string[]> {
  return (await io.readDir(folder))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/**
 * The Queue and skips. A card or skip that does not match the contract still counts as taken,
 * so Refresh never writes over a card or re-queues a skip it could not read.
 */
async function readQueue(io: RefreshIo, dir: string): Promise<CurrentQueue> {
  const cardsFolder = join(dir, "state", CARDS_COLLECTION);
  const cardIds = await savedIds(io, cardsFolder);
  const cards: Card[] = [];
  for (const docId of cardIds) {
    const result = validateCardDocument(
      docId,
      await readJson(io, join(cardsFolder, `${docId}.json`)),
    );
    if (result.ok) cards.push(result.value as Card);
  }
  const skippedIds = await savedIds(io, join(dir, "state", SKIPS_COLLECTION));
  return { cards, cardIds, skippedIds };
}

async function readSources(
  io: RefreshIo,
  dir: string,
): Promise<{ settings: SourceSettings; issues: string[] }> {
  const folder = join(dir, "state", SOURCES_COLLECTION);
  const docs: { id: string; data: unknown }[] = [];
  for (const id of await savedIds(io, folder)) {
    docs.push({ id, data: await readJson(io, join(folder, `${id}.json`)) });
  }
  return readSourceSettings(docs);
}

/** Reads every Source that is switched on; Postings added by URL need no reading. */
async function readEnabledSources(
  io: RefreshIo,
  now: string,
  sources: SourceSettings,
  feed: string | undefined,
): Promise<SourceResult[]> {
  const [jobFeed, watchlist] = await Promise.all([
    sources.jobFeed.enabled ? readFeed(io, now, feed).then((result) => [result]) : [],
    sources.watchlist.enabled ? readWatchlist(io.fetch, sources.watchlist.companies, now) : [],
  ]);
  return [...jobFeed, ...watchlist];
}

async function readVersions(io: RefreshIo, dir: string): Promise<Record<string, number>> {
  const json = await readJson(io, join(dir, "versions.json"));
  if (json === undefined) return {};
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new RefreshError("versions.json must map document paths to versions.");
  }
  const versions: Record<string, number> = {};
  for (const [path, version] of Object.entries(json)) {
    if (!Number.isInteger(version) || (version as number) < 1) {
      throw new RefreshError(
        `versions.json gives ${path} the version ${JSON.stringify(version)}; versions are whole numbers from 1.`,
      );
    }
    versions[path] = version as number;
  }
  return versions;
}

async function readFeed(
  io: RefreshIo,
  now: string,
  feed: string | undefined,
): Promise<SourceResult> {
  if (feed === undefined || /^https?:\/\//.test(feed)) return readJobFeed(io.fetch, now, feed);
  const json = await readJson(io, feed);
  if (json === undefined)
    return { name: JOB_FEED_SOURCE, ok: false, error: `Could not read ${feed}.` };
  return parseJobFeed(json, now);
}

async function readJudgments(io: RefreshIo, dir: string): Promise<Record<string, VariantJudgment>> {
  const path = join(dir, "variant-judgments.json");
  const json = await readJson(io, path);
  if (json === undefined) return {};
  const problem = (detail: string) =>
    new RefreshError(
      `${path} ${detail}. It maps Posting ids to { "variant": "<Resume Variant name>", "reason": "<why, in one sentence>" }.`,
    );
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw problem("is not a JSON object");
  }
  const judgments: Record<string, VariantJudgment> = {};
  for (const [id, entry] of Object.entries(json)) {
    if (!/^[0-9a-f]{12}$/.test(id)) throw problem(`has the key "${id}", which is not a Posting id`);
    const { variant, reason } = (entry ?? {}) as { variant?: unknown; reason?: unknown };
    if (typeof variant !== "string" || variant.trim() === "") {
      throw problem(`gives ${id} no variant`);
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw problem(`gives ${id} no reason`);
    }
    if (reason.trim().length > MAX_JUDGMENT_REASON) {
      throw problem(`gives ${id} a reason longer than ${String(MAX_JUDGMENT_REASON)} characters`);
    }
    judgments[id] = { variant: variant.trim(), reason: reason.trim() };
  }
  return judgments;
}

interface SavedSources {
  sources: SourceResult[];
}

export function batchesOf(writes: readonly { write: BatchWrite; bytes: number }[]): BatchWrite[][] {
  const batches: BatchWrite[][] = [];
  let batch: BatchWrite[] = [];
  let size = 0;
  for (const { write, bytes } of writes) {
    if (batch.length > 0 && (batch.length >= BATCH_MAX_WRITES || size + bytes > BATCH_MAX_BYTES)) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(write);
    size += bytes + 200;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

const number = (n: number) => n.toLocaleString("en-US");
const count = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

const LEFT_OUT_REASONS: Record<RefreshSummary["addedLeftOut"][number]["reason"], string> = {
  location: "outside your Location Tiers",
  seniority: "asks for more experience",
  startWindow: "outside your start window",
  roleType: "not one of your role types",
  company: "at a company you blocked",
  applySite: "only on an apply site you blocked",
};

function formatSources(summary: RefreshSummary): string[] {
  const lines: string[] = [];
  const watchlist = summary.sources.filter((source) => source.name === WATCHLIST_SOURCE);
  const others = summary.sources.filter((source) => source.name !== WATCHLIST_SOURCE);
  for (const source of others) {
    if (!source.ok) {
      lines.push(`- ${source.name}: FAILED. ${source.error ?? "No reason given."}`);
    } else if (source.name === ADDED_BY_URL_SOURCE) {
      lines.push(`- ${source.name}: ${number(source.postings)} Postings.`);
    } else {
      lines.push(`- ${source.name}: read ${number(source.postings)} Postings.`);
    }
  }
  if (watchlist.length > 0) {
    const read = watchlist.filter((source) => source.ok);
    const postings = read.reduce((sum, source) => sum + source.postings, 0);
    lines.push(
      `- ${WATCHLIST_SOURCE}: read ${number(postings)} Postings from ${number(read.length)} of ${number(watchlist.length)} companies.`,
    );
    for (const source of watchlist.filter((s) => !s.ok)) {
      lines.push(
        `- ${WATCHLIST_SOURCE}, ${source.list ?? "a company"}: FAILED. ${source.error ?? "No reason given."}`,
      );
    }
  }
  return lines;
}

export function formatSummary(
  summary: RefreshSummary,
  paths: { writes: string; review: string },
  batches: number,
  sourceIssues: readonly string[] = [],
): string {
  const { writes: writesPath, review: reviewPath } = paths;
  const lines: string[] = [];
  const tiers = summary.byTier
    .map((count, i) => `Tier ${String(i + 1)}: ${number(count)}`)
    .join(", ");
  lines.push(`Refresh finished at ${summary.refreshedAt.slice(0, 16).replace("T", " ")} UTC.`);
  lines.push(
    `Job List: ${number(summary.total)} Postings (${tiers}); ${number(summary.newPostings)} new and ${number(summary.removedPostings)} gone since the last Refresh.`,
  );
  if (summary.matched > summary.total) {
    lines.push(
      `${number(summary.matched)} Postings matched; the Job List keeps the best ${number(summary.total)}.`,
    );
  }
  if (summary.sources.length === 0) {
    lines.push(
      "Every Source is switched off or empty, so the Job List is empty. Switch a Source on in the dashboard's Sources panel.",
    );
  } else {
    lines.push("Sources:");
    lines.push(...formatSources(summary));
  }
  if (sourceIssues.length > 0) {
    lines.push(
      "Some Source documents do not match the dashboard contract, so those Sources were skipped:",
    );
    lines.push(...sourceIssues.map((issue) => `- ${issue}`));
  }
  if (summary.carriedOver > 0) {
    lines.push(
      `Kept ${number(summary.carriedOver)} Postings from the last Refresh because their Source failed.`,
    );
  }
  const { location, seniority, startWindow, roleType, company, applySite } = summary.filteredOut;
  if (summary.sources.some((source) => source.ok)) {
    const blocked = [
      company > 0 ? `, ${number(company)} at companies you blocked` : "",
      applySite > 0 ? `, ${number(applySite)} only on apply sites you blocked` : "",
    ].join("");
    lines.push(
      `Left out: ${number(location)} outside your Location Tiers, ${number(seniority)} at another seniority, ${number(startWindow)} outside your start window, ${number(roleType)} in other roles${blocked}.`,
    );
  }
  if (summary.addedLeftOut.length > 0) {
    const leftOut = summary.addedLeftOut.map(
      (posting) => `${posting.company}: ${posting.title} (${LEFT_OUT_REASONS[posting.reason]})`,
    );
    lines.push(`Added by URL but left out of the Job List: ${leftOut.join("; ")}.`);
  }
  if (summary.unresolvedLinks > 0) {
    lines.push(
      `${number(summary.unresolvedLinks)} short links could not be resolved and keep their short link.`,
    );
  }
  if (summary.unmatchedLocations.length > 0) {
    lines.push(
      `Location Tier entries that matched no Posting location: ${summary.unmatchedLocations.join(", ")}.`,
    );
  }
  const { queue } = summary;
  lines.push(
    `Queue: ${count(queue.size, "Posting")} for a daily target of ${number(queue.target)}; ${number(queue.preQueued)} pre-queued now and ${number(queue.carriedOver)} carried over.`,
  );
  if (queue.possiblyClosed > 0) {
    lines.push(
      `${count(queue.possiblyClosed, "Queue item has", "Queue items have")} waited ${String(POSSIBLY_CLOSED_DAYS)} or more days and may have closed.`,
    );
  }
  if (queue.notListed > 0) {
    lines.push(
      `${count(queue.notListed, "Queue item is", "Queue items are")} no longer in the Job List; the Posting may have closed.`,
    );
  }
  const variants = Object.entries(summary.byVariant)
    .map(([name, n]) => `${name} ${number(n)}`)
    .join(", ");
  lines.push(`Resume Variants: ${variants}.`);
  const { unsure } = summary.variantReview;
  if (unsure > 0) {
    lines.push(
      `${number(unsure)} unsure Resume Variant ${unsure === 1 ? "pick" : "picks"} to review: see ${reviewPath}.`,
    );
  }
  if (summary.top.length > 0) {
    lines.push("Top Postings:");
    summary.top.forEach((posting, i) => {
      lines.push(
        `${String(i + 1)}. ${posting.company}: ${posting.title} (${posting.locations.slice(0, 3).join("; ")}; Tier ${String(posting.locationTier)}; score ${String(posting.score)})`,
      );
    });
  }
  lines.push(
    `Next: send the ${batches === 1 ? "batch" : `${String(batches)} batches`} in ${writesPath} with ArtifactData, one batch call each, in order.`,
  );
  return `${lines.join("\n")}\n`;
}

/** Runs one Refresh and resolves the exit code. */
export async function runRefreshCommand(
  dirArg: string,
  options: RefreshOptions,
  io: RefreshIo,
): Promise<number> {
  const dir = resolve(dirArg);
  try {
    const settingsPath = join(dir, "state", "settings", "main.json");
    const settingsJson = await readJson(io, settingsPath);
    if (settingsJson === undefined) {
      throw new RefreshError(
        `No settings at ${settingsPath}. Read settings/main from the dashboard into ${join(dir, "state")} first.`,
      );
    }
    const settings = validateSettings(settingsJson);
    if (!settings.ok) {
      throw new RefreshError(
        `The settings document does not match the dashboard contract:\n${settings.issues.map((i) => `- ${i}`).join("\n")}`,
      );
    }
    const { current, existing } = await readState(io, dir);
    const versions = await readVersions(io, dir);
    const missing = existing.filter(
      (docId) => versions[`${POSTINGS_COLLECTION}/${docId}`] === undefined,
    );
    if (missing.length > 0) {
      throw new RefreshError(
        `versions.json has no version for ${missing.map((id) => `${POSTINGS_COLLECTION}/${id}`).join(", ")}. Add the version ArtifactData reported for each document read.`,
      );
    }

    const sourceSettings = await readSources(io, dir);
    const judgments = await readJudgments(io, dir);
    const queue = await readQueue(io, dir);
    const out = join(dir, "out");
    const sourcesPath = join(out, "sources.json");

    const now = io.now();
    const cachePath = join(dir, "short-links.json");
    const cacheJson = await readJson(io, cachePath);
    const cache =
      typeof cacheJson === "object" && cacheJson !== null
        ? (cacheJson as Record<string, string>)
        : {};
    let sources: SourceResult[];
    let resolved: Record<string, string>;
    if (options.rerun) {
      const saved = (await readJson(io, sourcesPath)) as SavedSources | undefined;
      if (!saved || !Array.isArray(saved.sources)) {
        throw new RefreshError(
          `No Sources saved at ${sourcesPath}. Run jaa refresh without --rerun first.`,
        );
      }
      sources = saved.sources;
      resolved = cache;
    } else {
      sources = await readEnabledSources(io, now, sourceSettings.settings, options.feed);
      const base = {
        now,
        settings: settings.value,
        sourceSettings: sourceSettings.settings,
        sources,
        current,
        queue,
      };
      resolved = (await resolveShortLinks(shortLinksToResolve(base), { fetch: io.fetch, cache }))
        .resolved;
      await io.writeFile(cachePath, `${JSON.stringify({ ...cache, ...resolved }, null, 2)}\n`);
    }

    const { jobList, changeSet, summary } = runRefresh({
      now,
      settings: settings.value,
      sourceSettings: sourceSettings.settings,
      sources,
      current,
      queue,
      resolvedLinks: resolved,
      variantJudgments: judgments,
    });

    await io.removeDir(out);
    await io.makeDir(out);
    await io.writeFile(sourcesPath, `${JSON.stringify({ sources } satisfies SavedSources)}\n`);
    if (Object.keys(judgments).length > 0) {
      // Keep only judgments that still apply, so the file does not grow forever.
      const listed = new Set(jobList.map((p) => p.id));
      const names = new Set(settings.value.resumeVariants.map((v) => v.name));
      const kept = Object.fromEntries(
        Object.entries(judgments).filter(([id, j]) => listed.has(id) && names.has(j.variant)),
      );
      await io.writeFile(join(dir, "variant-judgments.json"), `${JSON.stringify(kept, null, 2)}\n`);
    }
    for (const collection of new Set(changeSet.set.map((w) => w.collection))) {
      await io.makeDir(join(out, collection));
    }
    const versionOf = (collection: string, docId: string) => versions[`${collection}/${docId}`];
    const writes: { write: BatchWrite; bytes: number }[] = [];
    for (const { collection, docId, data } of changeSet.set) {
      const check = validateDocument(collection, docId, data);
      if (!check.ok) {
        throw new RefreshError(
          `Refresh built an invalid ${collection}/${docId}:\n${check.issues.map((i) => `- ${i}`).join("\n")}`,
        );
      }
      const filePath = join(out, collection, `${docId}.json`);
      const text = `${JSON.stringify(data)}\n`;
      await io.writeFile(filePath, text);
      const write: BatchWrite = { op: "set", collection, doc_id: docId, file_path: filePath };
      const version = versionOf(collection, docId);
      if (version !== undefined) write.if_version = version;
      writes.push({ write, bytes: Buffer.byteLength(text) });
    }
    const written = new Set(
      changeSet.set.filter((w) => w.collection === POSTINGS_COLLECTION).map((w) => w.docId),
    );
    const removals = new Set([
      ...changeSet.delete.map((d) => d.docId),
      ...existing.filter((id) => !written.has(id)),
    ]);
    for (const docId of [...removals].sort()) {
      const write: BatchWrite = { op: "delete", collection: POSTINGS_COLLECTION, doc_id: docId };
      const version = versionOf(POSTINGS_COLLECTION, docId);
      if (version !== undefined) write.if_version = version;
      writes.push({ write, bytes: 0 });
    }
    const batches = batchesOf(writes);
    const writesPath = join(out, "writes.json");
    await io.writeFile(writesPath, `${JSON.stringify({ batches }, null, 2)}\n`);
    await io.writeFile(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const reviewPath = join(out, "variant-review.json");
    const review = { variants: settings.value.resumeVariants, ...summary.variantReview };
    await io.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    io.stdout(
      formatSummary(
        summary,
        { writes: writesPath, review: reviewPath },
        batches.length,
        sourceSettings.issues,
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof RefreshError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
