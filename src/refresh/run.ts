/**
 * `jaa refresh <dir>`: the Refresh adapter. It reads the dashboard state the Refresh skill saved
 * under `<dir>/state` (ArtifactData reads with `out_dir`), fetches the Job Feed, resolves short
 * links, runs the deterministic engine, validates every document, and writes the documents plus
 * ready-to-send ArtifactData batches under `<dir>/out`.
 *
 * Layout of `<dir>`:
 * - state/settings/main.json, state/postings/<doc-id>.json, state/cards/<doc-id>.json,
 *   state/skips/<doc-id>.json: the current dashboard documents.
 * - versions.json: `{ "postings/<doc-id>": <version> }` for every postings document read.
 * - short-links.json: short links resolved on earlier Refreshes (kept between runs).
 * - out/postings/<doc-id>.json, out/cards/<doc-id>.json, out/writes.json, out/summary.json: what
 *   this run produced. Refresh only creates cards, so card writes carry no version.
 */
import { join, resolve } from "node:path";
import {
  CARDS_COLLECTION,
  POSSIBLY_CLOSED_DAYS,
  POSTINGS_COLLECTION,
  SKIPS_COLLECTION,
  validateCardDocument,
  validateDocument,
  validatePostingsDocument,
  validateSettings,
  type Card,
  type JobListMeta,
  type JobListPage,
} from "../contract/index.ts";
import type { CurrentQueue } from "../engine/queue.ts";
import {
  runRefresh,
  shortLinksToResolve,
  type CurrentJobList,
  type RefreshSummary,
} from "../engine/refresh.ts";
import type { SourceResult } from "../engine/source.ts";
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

class RefreshError extends Error {}

async function readJson(io: RefreshIo, path: string): Promise<unknown> {
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
async function savedIds(io: RefreshIo, folder: string): Promise<string[]> {
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
  if (json === undefined) return { name: "Job Feed", ok: false, error: `Could not read ${feed}.` };
  return parseJobFeed(json, now);
}

function batchesOf(writes: readonly { write: BatchWrite; bytes: number }[]): BatchWrite[][] {
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

export function formatSummary(
  summary: RefreshSummary,
  writesPath: string,
  batches: number,
): string {
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
  lines.push("Sources:");
  for (const source of summary.sources) {
    lines.push(
      source.ok
        ? `- ${source.name}: read ${number(source.postings)} Postings.`
        : `- ${source.name}: FAILED. ${source.error ?? "No reason given."}`,
    );
  }
  if (summary.carriedOver > 0) {
    lines.push(
      `Kept ${number(summary.carriedOver)} Postings from the last Refresh because their Source failed.`,
    );
  }
  const { location, seniority, startWindow, roleType } = summary.filteredOut;
  if (summary.sources.some((source) => source.ok)) {
    lines.push(
      `Left out: ${number(location)} outside your Location Tiers, ${number(seniority)} at another seniority, ${number(startWindow)} outside your start window, ${number(roleType)} in other roles.`,
    );
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

    const now = io.now();
    const feed = await readFeed(io, now, options.feed);
    const queue = await readQueue(io, dir);
    const base = { now, settings: settings.value, sources: [feed], current, queue };

    const cachePath = join(dir, "short-links.json");
    const cacheJson = await readJson(io, cachePath);
    const cache =
      typeof cacheJson === "object" && cacheJson !== null
        ? (cacheJson as Record<string, string>)
        : {};
    const { resolved } = await resolveShortLinks(shortLinksToResolve(base), {
      fetch: io.fetch,
      cache,
    });
    await io.writeFile(cachePath, `${JSON.stringify({ ...cache, ...resolved }, null, 2)}\n`);

    const { changeSet, summary } = runRefresh({ ...base, resolvedLinks: resolved });

    const out = join(dir, "out");
    await io.removeDir(out);
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
    io.stdout(formatSummary(summary, writesPath, batches.length));
    return 0;
  } catch (error) {
    if (error instanceof RefreshError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
