/**
 * Reads the day's threads from the forums the News Digest covers, for the Refresh skill to pick
 * highlights from: the top threads of r/csMajors and r/cscareerquestions from Reddit's public
 * RSS feed, and the Hacker News front page from its public search API. Claude's own web tools
 * cannot reach Reddit, so `jaa news plan` reads them here under an honest user agent. Reddit
 * allows a reader without an account one request a minute, so both subreddits come in one
 * combined feed. Blind and LinkedIn are never read (hard rule 3).
 */
import { FORUMS, type Forum } from "../contract/index.ts";
import type { Fetch } from "./job-feed.ts";

export const USER_AGENT = "job-app-assist (+https://github.com/dereksun64/job-app-assist)";

/** The day's top threads of both subreddits, each entry tagged with its subreddit. */
export const REDDIT_FEED =
  "https://www.reddit.com/r/csMajors+cscareerquestions/top/.rss?t=day&limit=40";
export const HACKER_NEWS_FEED =
  "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30";

const SUBREDDITS: Record<string, Forum> = {
  csmajors: "r/csMajors",
  cscareerquestions: "r/cscareerquestions",
};
/** Threads kept per subreddit, in the feed's order (top first). */
const THREADS_PER_SUBREDDIT = 15;

const TIMEOUT_MS = 20_000;
/** The longest a rate limit is waited out before a forum counts as unreadable today. */
const MAX_RETRY_WAIT_MS = 65_000;
const EXCERPT_CHARS = 300;

export interface ForumThread {
  title: string;
  /** The thread itself, on the forum. */
  url: string;
  postedAt: string;
  /** The opening post, as plain text, cut short. */
  excerpt?: string;
  points?: number;
  comments?: number;
  /** For a Hacker News story, the article it links to. */
  links?: string;
}

export type ForumRead =
  { forum: Forum; ok: true; threads: ForumThread[] } | { forum: Forum; ok: false; error: string };

export interface ForumIo {
  fetch: Fetch;
  sleep(ms: number): Promise<void>;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function plain(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(text: string): string | undefined {
  if (text === "") return undefined;
  return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

/** The threads in a Reddit Atom feed, by subreddit, in the feed's order. */
export function parseRedditFeed(xml: string): Map<Forum, ForumThread[]> | undefined {
  if (!/<feed[\s>]/.test(xml)) return undefined;
  const bySubreddit = new Map<Forum, ForumThread[]>(
    Object.values(SUBREDDITS).map((forum) => [forum, []]),
  );
  for (const [, entry = ""] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const subreddit = /<category term="([^"]+)"/.exec(entry)?.[1]?.toLowerCase() ?? "";
    const threads = bySubreddit.get(SUBREDDITS[subreddit] ?? ("" as Forum));
    if (!threads || threads.length >= THREADS_PER_SUBREDDIT) continue;
    const title = plain(tag(entry, "title") ?? "");
    const url = /<link href="([^"]+)"/.exec(entry)?.[1];
    const postedAt = tag(entry, "published") ?? tag(entry, "updated") ?? "";
    if (title === "" || url === undefined) continue;
    // The post body, without the "submitted by /u/... [link] [comments]" footer Reddit adds.
    const body = decode(tag(entry, "content") ?? "")
      .replace(/<!-- SC_ON -->[\s\S]*$/, "")
      .replace(/submitted by[\s\S]*$/, "");
    const thread: ForumThread = { title, url: decode(url), postedAt };
    const text = excerpt(plain(body));
    if (text !== undefined) thread.excerpt = text;
    threads.push(thread);
  }
  return bySubreddit;
}

interface HnHit {
  objectID?: unknown;
  title?: unknown;
  url?: unknown;
  points?: unknown;
  num_comments?: unknown;
  created_at?: unknown;
  story_text?: unknown;
}

/** The stories on the Hacker News front page, most points first. */
export function parseHackerNews(json: unknown): ForumThread[] | undefined {
  const hits = (json as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return undefined;
  return (hits as HnHit[])
    .flatMap((hit): ForumThread[] => {
      if (typeof hit.objectID !== "string" || typeof hit.title !== "string") return [];
      const thread: ForumThread = {
        title: hit.title,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        postedAt: typeof hit.created_at === "string" ? hit.created_at : "",
      };
      if (typeof hit.points === "number") thread.points = hit.points;
      if (typeof hit.num_comments === "number") thread.comments = hit.num_comments;
      if (typeof hit.url === "string" && hit.url !== "") thread.links = hit.url;
      if (typeof hit.story_text === "string") {
        const text = excerpt(plain(hit.story_text));
        if (text !== undefined) thread.excerpt = text;
      }
      return [thread];
    })
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "it took too long to answer";
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : error.message;
  }
  return String(error);
}

/** How long a 429 answer asks to wait, from `Retry-After` or Reddit's `x-ratelimit-reset`. */
function retryWait(response: Response): number {
  for (const header of ["retry-after", "x-ratelimit-reset"]) {
    const seconds = Number(response.headers.get(header) ?? Number.NaN);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds) * 1000;
  }
  return 5000;
}

/** Waits out one rate limit, when it ends soon enough, then tries once more. */
async function get(url: string, io: ForumIo): Promise<Response> {
  const request = () =>
    io.fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const response = await request();
  if (response.status !== 429) return response;
  const wait = retryWait(response);
  if (wait > MAX_RETRY_WAIT_MS) return response;
  await io.sleep(wait);
  return request();
}

async function read(
  name: string,
  url: string,
  io: ForumIo,
  parse: (response: Response) => Promise<unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await get(url, io);
  } catch (error) {
    return { ok: false, error: `${name} could not be reached: ${describe(error)}.` };
  }
  if (!response.ok) {
    return { ok: false, error: `${name} answered HTTP ${String(response.status)}.` };
  }
  try {
    const data = await parse(response);
    if (data !== undefined) return { ok: true, data };
  } catch {
    // Reported below as data in an unexpected format.
  }
  return { ok: false, error: `${name} sent data in an unexpected format.` };
}

/** Reads both subreddits and Hacker News; a forum that fails is reported, never thrown. */
export async function readForums(io: ForumIo): Promise<ForumRead[]> {
  const reddit = await read("Reddit", REDDIT_FEED, io, async (r) =>
    parseRedditFeed(await r.text()),
  );
  const hn = await read("Hacker News", HACKER_NEWS_FEED, io, async (r) =>
    parseHackerNews(await r.json()),
  );
  return FORUMS.map((forum): ForumRead => {
    if (forum === "Hacker News") {
      return hn.ok
        ? { forum, ok: true, threads: hn.data as ForumThread[] }
        : { forum, ok: false, error: hn.error };
    }
    return reddit.ok
      ? { forum, ok: true, threads: (reddit.data as Map<Forum, ForumThread[]>).get(forum) ?? [] }
      : { forum, ok: false, error: reddit.error };
  });
}
