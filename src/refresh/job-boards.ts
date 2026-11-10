/**
 * Reading watchlist companies straight from their public job boards on Greenhouse, Lever and
 * Ashby. Each board has a keyless public API listing every open job; this is the adapter side
 * of Refresh, so the engine only ever sees the parsed Source Postings.
 */
import {
  JOB_BOARD_NAMES,
  WATCHLIST_SOURCE,
  jobBoardUrl,
  type WatchedCompany,
} from "../contract/index.ts";
import type { SourcePosting, SourceResult } from "../engine/source.ts";
import type { Fetch } from "./job-feed.ts";

const BOARD_TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;

export function jobBoardApiUrl({ board, slug }: WatchedCompany): string {
  const name = encodeURIComponent(slug);
  switch (board) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${name}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${name}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${name}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const texts = (value: unknown) =>
  Array.isArray(value) ? value.map(text).filter((item) => item !== "") : [];

/** One board job, before the company's name and list are added. */
type BoardJob = Pick<SourcePosting, "applyUrl" | "title" | "location" | "jobType" | "postedAt">;

function greenhouseJobs(json: unknown): BoardJob[] | undefined {
  if (!isRecord(json) || !Array.isArray(json.jobs)) return undefined;
  return json.jobs.filter(isRecord).map((job) => ({
    applyUrl: text(job.absolute_url),
    title: text(job.title),
    location: isRecord(job.location) ? text(job.location.name) : "",
    jobType: "",
    postedAt: text(job.first_published) || text(job.updated_at),
  }));
}

function leverJobs(json: unknown): BoardJob[] | undefined {
  if (!Array.isArray(json)) return undefined;
  return json.filter(isRecord).map((job) => {
    const categories = isRecord(job.categories) ? job.categories : {};
    const locations = texts(categories.allLocations);
    const location = locations.length > 0 ? locations.join("; ") : text(categories.location);
    const created = typeof job.createdAt === "number" ? new Date(job.createdAt) : undefined;
    return {
      applyUrl: text(job.hostedUrl),
      title: text(job.text),
      location: location || (text(job.workplaceType) === "remote" ? "Remote" : ""),
      jobType: text(categories.commitment),
      postedAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : "",
    };
  });
}

function ashbyJobs(json: unknown): BoardJob[] | undefined {
  if (!isRecord(json) || !Array.isArray(json.jobs)) return undefined;
  return json.jobs
    .filter(isRecord)
    .filter((job) => job.isListed !== false)
    .map((job) => {
      const secondary = Array.isArray(job.secondaryLocations)
        ? job.secondaryLocations.map((place) => (isRecord(place) ? text(place.location) : ""))
        : [];
      let location = [text(job.location), ...secondary].filter(Boolean).join("; ");
      if (text(job.workplaceType) === "Remote" && !/remote/i.test(location)) {
        location = location ? `Remote in ${location}` : "Remote";
      }
      return {
        applyUrl: text(job.jobUrl),
        title: text(job.title),
        location,
        jobType: text(job.employmentType),
        postedAt: text(job.publishedAt),
      };
    });
}

const PARSERS = { greenhouse: greenhouseJobs, lever: leverJobs, ashby: ashbyJobs };

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "it took too long to answer";
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : error.message;
  }
  return String(error);
}

/** Reads one watchlist company's job board; every failure becomes a failing read, never a throw. */
export async function readJobBoard(
  fetch: Fetch,
  company: WatchedCompany,
  now: string,
): Promise<SourceResult> {
  const scope = { name: WATCHLIST_SOURCE, list: company.name };
  const board = `${company.name}'s ${JOB_BOARD_NAMES[company.board]} job board`;
  const fail = (error: string): SourceResult => ({ ...scope, ok: false, error });
  let response: Response;
  try {
    response = await fetch(jobBoardApiUrl(company), {
      signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(`${board} could not be reached: ${describe(error)}.`);
  }
  if (response.status === 404) {
    return fail(
      `${company.name} has no public ${JOB_BOARD_NAMES[company.board]} job board at ${jobBoardUrl(company)}. Check its link on the watchlist.`,
    );
  }
  if (!response.ok) return fail(`${board} answered HTTP ${String(response.status)}.`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const jobs = PARSERS[company.board](json);
  if (!jobs) return fail(`${board} sent data in an unexpected format.`);
  const postings: SourcePosting[] = jobs
    .filter((job) => job.applyUrl !== "" && job.title !== "")
    .map((job) => ({
      applyUrl: job.applyUrl,
      company: company.name,
      title: job.title,
      location: job.location,
      jobType: job.jobType,
      age: "",
      ...(job.postedAt ? { postedAt: job.postedAt } : {}),
      category: "",
      companyTier: "",
      list: company.name,
    }));
  return { ...scope, ok: true, listsEveryLevel: true, fetchedAt: now, postings };
}

/** Reads every watchlist company's board, a few at a time, in watchlist order. */
export async function readWatchlist(
  fetch: Fetch,
  companies: readonly WatchedCompany[],
  now: string,
): Promise<SourceResult[]> {
  const results: SourceResult[] = new Array<SourceResult>(companies.length);
  let next = 0;
  const worker = async () => {
    while (next < companies.length) {
      const index = next++;
      const company = companies[index];
      if (company === undefined) break;
      results[index] = await readJobBoard(fetch, company, now);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, companies.length) }, worker));
  return results;
}
