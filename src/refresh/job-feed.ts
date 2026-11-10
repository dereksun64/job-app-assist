/**
 * Reading the Job Feed: the shared `jobs.json` that yet-another-job-repo publishes.
 * This is the adapter side of Refresh; the engine only ever sees the parsed Source Postings.
 */
import { JOB_FEED, type SourcePosting, type SourceResult } from "../engine/source.ts";

export const JOB_FEED_URL =
  "https://raw.githubusercontent.com/dereksun64/yet-another-job-repo/main/data/jobs.json";

const FEED_TIMEOUT_MS = 60_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Parses the Job Feed's JSON into Source Postings. Entries without an apply URL, company or
 * title are skipped; a payload without a `jobs` list is an error.
 */
export function parseJobFeed(json: unknown, fallbackTime: string): SourceResult {
  if (!isRecord(json) || !Array.isArray(json.jobs)) {
    return {
      name: JOB_FEED,
      ok: false,
      error: "The Job Feed's data is not in the expected format (no jobs list).",
    };
  }
  const generated = text(json.generatedAt) || text(json.fetchedAt);
  const fetchedAt = Number.isNaN(Date.parse(generated))
    ? fallbackTime
    : new Date(generated).toISOString();
  const postings: SourcePosting[] = [];
  for (const job of json.jobs) {
    if (!isRecord(job)) continue;
    const applyUrl = text(job.applyUrl).trim();
    const company = text(job.company).trim();
    const title = text(job.title).trim();
    if (!applyUrl || !company || !title) continue;
    const posting: SourcePosting = {
      applyUrl,
      company,
      title,
      location: text(job.location),
      jobType: text(job.jobType),
      age: text(job.age),
      category: text(job.category),
      companyTier: text(job.companyTier),
    };
    const list = text(job.source).trim();
    if (list) posting.list = list;
    postings.push(posting);
  }
  return { name: JOB_FEED, ok: true, fetchedAt, postings };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "it took too long to answer";
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : error.message;
  }
  return String(error);
}

/** Fetches and parses the Job Feed; every failure becomes a failing Source, never a throw. */
export async function readJobFeed(
  fetch: Fetch,
  now: string,
  url = JOB_FEED_URL,
): Promise<SourceResult> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  } catch (error) {
    return {
      name: JOB_FEED,
      ok: false,
      error: `The Job Feed could not be reached: ${describe(error)}.`,
    };
  }
  if (!response.ok) {
    return {
      name: JOB_FEED,
      ok: false,
      error: `The Job Feed answered HTTP ${String(response.status)}.`,
    };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { name: JOB_FEED, ok: false, error: "The Job Feed's data is not valid JSON." };
  }
  return parseJobFeed(json, now);
}
