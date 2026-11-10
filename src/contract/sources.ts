import * as z from "zod/mini";
import { canonicalApplyUrl } from "./apply-urls.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The sources collection holds one document per Source, each with the Candidate's on/off
 * switch: the shared Job Feed, the watchlist (companies read straight from their public
 * Greenhouse, Lever or Ashby job boards), and the Postings the Candidate added by URL.
 * Only the dashboard page and Setup write here; Refresh reads it and skips Sources that are off.
 */
export const SOURCES_COLLECTION = "sources";
export const JOB_FEED_SOURCE_ID = "job-feed";
export const WATCHLIST_SOURCE_ID = "watchlist";
export const ADDED_BY_URL_SOURCE_ID = "added-by-url";
export const SOURCE_IDS = [
  JOB_FEED_SOURCE_ID,
  WATCHLIST_SOURCE_ID,
  ADDED_BY_URL_SOURCE_ID,
] as const;

/** The names Postings carry for the watchlist and Add by URL Sources. */
export const WATCHLIST_SOURCE = "Watchlist";
export const ADDED_BY_URL_SOURCE = "Added by URL";

export const JOB_BOARDS = ["greenhouse", "lever", "ashby"] as const;
export const JOB_BOARD_NAMES: Record<JobBoard, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};
export const MAX_WATCHLIST = 200;
export const MAX_ADDED_POSTINGS = 200;

const text = (max: number) =>
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(max, `must be ${String(max)} characters or fewer`),
    );

const webAddress = z
  .string()
  .check(
    z.trim(),
    z.maxLength(2000, "must be 2000 characters or fewer"),
    z.regex(/^https?:\/\/[^\s/]+\.[^\s]*$/, "must be an http or https web address"),
  );

const timestamp = z.iso.datetime({ error: "must be an ISO 8601 timestamp" });

/** A job board slug: one path segment, as it appears in the board's links. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const watchedCompany = z.strictObject({
  /** The company's name as the Candidate wants it shown. */
  name: text(200),
  board: z.enum(JOB_BOARDS),
  /** The company's name in its job board link, for example `stripe`. */
  slug: z
    .string()
    .check(z.regex(SLUG, "must be the company's name in its job board link, for example stripe")),
});

const addedPosting = z.strictObject({
  /** The URL the Candidate pasted; Refresh uses it as the apply URL. */
  url: webAddress,
  company: text(200),
  title: text(300),
  /** Where the job is, as the Candidate typed it, for example "New York, NY" or "Remote". */
  location: text(200),
  addedAt: timestamp,
});

/** Adds one issue per entry whose key repeats an earlier entry's. */
function noRepeats<T>(key: (entry: T) => string, message: (entry: T) => string) {
  return z.superRefine<T[]>((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const k = key(entry);
      if (seen.has(k)) ctx.addIssue({ code: "custom", message: message(entry), input: entry });
      seen.add(k);
    }
  });
}

const jobFeedSource = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  updatedAt: timestamp,
});

const watchlistSource = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  companies: z.array(watchedCompany).check(
    z.maxLength(MAX_WATCHLIST, `the watchlist holds at most ${String(MAX_WATCHLIST)} companies`),
    noRepeats(
      (company) => `${company.board}/${company.slug.toLowerCase()}`,
      (company) => `${company.name} is already on the watchlist`,
    ),
  ),
  updatedAt: timestamp,
});

const addedByUrlSource = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  postings: z.array(addedPosting).check(
    z.maxLength(MAX_ADDED_POSTINGS, `at most ${String(MAX_ADDED_POSTINGS)} Postings can be added`),
    noRepeats(
      (posting) => canonicalApplyUrl(posting.url),
      (posting) => `${posting.url} is already added`,
    ),
  ),
  updatedAt: timestamp,
});

export type JobBoard = (typeof JOB_BOARDS)[number];
export type WatchedCompany = z.output<typeof watchedCompany>;
export type AddedPosting = z.output<typeof addedPosting>;
export type JobFeedSource = z.output<typeof jobFeedSource>;
export type WatchlistSource = z.output<typeof watchlistSource>;
export type AddedByUrlSource = z.output<typeof addedByUrlSource>;
export type SourceId = (typeof SOURCE_IDS)[number];

export function validateJobFeedSource(input: unknown): Validation<JobFeedSource> {
  return validateWith(jobFeedSource, input);
}

export function validateWatchlistSource(input: unknown): Validation<WatchlistSource> {
  return validateWith(watchlistSource, input);
}

export function validateAddedByUrlSource(input: unknown): Validation<AddedByUrlSource> {
  return validateWith(addedByUrlSource, input);
}

/** Validates any document in the sources collection by its id. */
export function validateSourceDocument(docId: string, input: unknown): Validation<unknown> {
  switch (docId) {
    case JOB_FEED_SOURCE_ID:
      return validateJobFeedSource(input);
    case WATCHLIST_SOURCE_ID:
      return validateWatchlistSource(input);
    case ADDED_BY_URL_SOURCE_ID:
      return validateAddedByUrlSource(input);
    default:
      return {
        ok: false,
        issues: [
          `The sources collection holds "${JOB_FEED_SOURCE_ID}", "${WATCHLIST_SOURCE_ID}" and "${ADDED_BY_URL_SOURCE_ID}".`,
        ],
      };
  }
}

/** Every Source's switch and contents, as Refresh and the page work with them. */
export interface SourceSettings {
  jobFeed: { enabled: boolean };
  watchlist: { enabled: boolean; companies: WatchedCompany[] };
  addedByUrl: { enabled: boolean; postings: AddedPosting[] };
}

/** What a Candidate has before touching the Sources panel: every Source on, nothing added. */
export function defaultSourceSettings(): SourceSettings {
  return {
    jobFeed: { enabled: true },
    watchlist: { enabled: true, companies: [] },
    addedByUrl: { enabled: true, postings: [] },
  };
}

/**
 * Reads the sources collection over the defaults. A missing document means that Source has
 * its default; a document outside the contract is reported and its Source is treated as off,
 * so Refresh never reads a Source the Candidate may have switched off.
 */
export function readSourceSettings(docs: readonly { id: string; data: unknown }[]): {
  settings: SourceSettings;
  issues: string[];
} {
  const settings = defaultSourceSettings();
  const issues: string[] = [];
  const report = (id: string, found: string[]) => {
    issues.push(...found.map((issue) => `${SOURCES_COLLECTION}/${id}: ${issue}`));
  };
  for (const { id, data } of docs) {
    if (id === JOB_FEED_SOURCE_ID) {
      const result = validateJobFeedSource(data);
      if (result.ok) settings.jobFeed = { enabled: result.value.enabled };
      else {
        settings.jobFeed = { enabled: false };
        report(id, result.issues);
      }
    } else if (id === WATCHLIST_SOURCE_ID) {
      const result = validateWatchlistSource(data);
      if (result.ok) {
        settings.watchlist = { enabled: result.value.enabled, companies: result.value.companies };
      } else {
        settings.watchlist = { enabled: false, companies: [] };
        report(id, result.issues);
      }
    } else if (id === ADDED_BY_URL_SOURCE_ID) {
      const result = validateAddedByUrlSource(data);
      if (result.ok) {
        settings.addedByUrl = { enabled: result.value.enabled, postings: result.value.postings };
      } else {
        settings.addedByUrl = { enabled: false, postings: [] };
        report(id, result.issues);
      }
    }
  }
  return { settings, issues };
}

/** A company's public job board. */
export interface JobBoardRef {
  board: JobBoard;
  slug: string;
}

function parseUrl(url: string): URL | undefined {
  const trimmed = url.trim();
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The public job board a link points into: a board's own page, any job on it, or its API.
 * Undefined for links that are not on Greenhouse, Lever or Ashby.
 */
export function jobBoardFromUrl(url: string): JobBoardRef | undefined {
  const parsed = parseUrl(url);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);
  let ref: JobBoardRef | undefined;
  if (host === "boards-api.greenhouse.io") {
    const slug = segments[0] === "v1" && segments[1] === "boards" ? segments[2] : undefined;
    if (slug) ref = { board: "greenhouse", slug };
  } else if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const slug = segments[0] === "embed" ? parsed.searchParams.get("for") : segments[0];
    if (slug) ref = { board: "greenhouse", slug };
  } else if (host === "jobs.lever.co") {
    if (segments[0]) ref = { board: "lever", slug: segments[0] };
  } else if (host === "jobs.ashbyhq.com") {
    if (segments[0]) ref = { board: "ashby", slug: segments[0] };
  }
  return ref && SLUG.test(ref.slug) ? ref : undefined;
}

/** The job board's own page, for the Candidate to open. */
export function jobBoardUrl({ board, slug }: JobBoardRef): string {
  switch (board) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${slug}`;
    case "lever":
      return `https://jobs.lever.co/${slug}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${slug}`;
  }
}
