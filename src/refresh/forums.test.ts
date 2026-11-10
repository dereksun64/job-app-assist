import { describe, expect, it } from "vitest";
import {
  HACKER_NEWS_FEED,
  REDDIT_FEED,
  USER_AGENT,
  parseHackerNews,
  parseRedditFeed,
  readForums,
  type ForumIo,
} from "./forums.ts";

const entry = (id: string, title: string, body: string, subreddit = "csMajors") => `<entry>
<author><name>/u/someone</name></author><category term="${subreddit}" label="r/${subreddit}"/>
<content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;${body}&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/someone&quot;&gt; /u/someone &lt;/a&gt; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/${subreddit}/comments/${id}/x/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content>
<id>t3_${id}</id>
<link href="https://www.reddit.com/r/${subreddit}/comments/${id}/x/" />
<updated>2026-11-10T03:11:44+00:00</updated><published>2026-11-10T03:11:44+00:00</published>
<title>${title}</title>
</entry>`;

const feed = (...entries: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>top scoring links : csMajors+cscareerquestions</title>${entries.join("")}</feed>`;

const hn = {
  hits: [
    {
      objectID: "2",
      title: "Show HN: A thing",
      points: 40,
      num_comments: 3,
      created_at: "2026-11-10T01:00:00Z",
      url: "https://example.com/thing",
    },
    {
      objectID: "1",
      title: "Ask HN: Who is hiring? (November 2026)",
      points: 500,
      num_comments: 900,
      created_at: "2026-11-01T15:00:00Z",
      url: null,
      story_text: "<p>Please state the location &amp; remote.</p>",
    },
    { title: "no id" },
  ],
};

const csMajors = (xml: string) => parseRedditFeed(xml)?.get("r/csMajors") ?? [];

describe("parseRedditFeed", () => {
  it("reads each thread's title, link, time and opening post as plain text", () => {
    expect(
      csMajors(
        feed(
          entry(
            "1abc",
            "Offers &amp; OAs",
            "I&amp;#39;m starting &lt;b&gt;freshman&lt;/b&gt; year",
          ),
        ),
      ),
    ).toEqual([
      {
        title: "Offers & OAs",
        url: "https://www.reddit.com/r/csMajors/comments/1abc/x/",
        postedAt: "2026-11-10T03:11:44+00:00",
        excerpt: "I'm starting freshman year",
      },
    ]);
  });

  it("sorts the combined feed's threads by subreddit, keeping the top 15 of each", () => {
    const entries = [
      entry("a", "A", "a", "cscareerquestions"),
      ...Array.from({ length: 16 }, (_, i) => entry(`m${String(i)}`, `M${String(i)}`, "m")),
      entry("o", "Other", "o", "learnprogramming"),
    ];
    const threads = parseRedditFeed(feed(...entries));
    expect(threads?.get("r/cscareerquestions")?.map((t) => t.title)).toEqual(["A"]);
    expect(threads?.get("r/csMajors")).toHaveLength(15);
    expect(threads?.get("r/csMajors")?.[0]?.title).toBe("M0");
  });

  it("cuts a long opening post short", () => {
    const [thread] = csMajors(feed(entry("1", "Long", "word ".repeat(200))));
    expect(thread?.excerpt?.length).toBeLessThanOrEqual(300);
    expect(thread?.excerpt?.endsWith("…")).toBe(true);
  });

  it("leaves out the excerpt of a link post with no text", () => {
    const [thread] = csMajors(feed(entry("1", "Link", "")));
    expect(thread).not.toHaveProperty("excerpt");
  });

  it("knows a page that is not a feed", () => {
    expect(parseRedditFeed("<html><body>blocked</body></html>")).toBeUndefined();
  });
});

describe("parseHackerNews", () => {
  it("links each front page story's discussion, most points first", () => {
    expect(parseHackerNews(hn)).toEqual([
      {
        title: "Ask HN: Who is hiring? (November 2026)",
        url: "https://news.ycombinator.com/item?id=1",
        postedAt: "2026-11-01T15:00:00Z",
        points: 500,
        comments: 900,
        excerpt: "Please state the location & remote.",
      },
      {
        title: "Show HN: A thing",
        url: "https://news.ycombinator.com/item?id=2",
        postedAt: "2026-11-10T01:00:00Z",
        points: 40,
        comments: 3,
        links: "https://example.com/thing",
      },
    ]);
  });

  it("knows data in the wrong shape", () => {
    expect(parseHackerNews({ nope: true })).toBeUndefined();
  });
});

type Answer = () => Response;

function fakeIo(routes: Record<string, Answer[]>): ForumIo & { calls: string[]; slept: number[] } {
  const calls: string[] = [];
  const slept: number[] = [];
  return {
    calls,
    slept,
    fetch: (url, init) => {
      calls.push(`${url} ${new Headers(init?.headers).get("user-agent") ?? ""}`);
      const next = routes[url]?.shift();
      return next
        ? Promise.resolve(next())
        : Promise.reject(
            new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }),
          );
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

const ok = (body: string) => () => new Response(body, { status: 200 });
const tooMany =
  (headers: Record<string, string> = {}) =>
  () =>
    new Response("", { status: 429, headers });

describe("readForums", () => {
  it("reads both subreddits in one request and Hacker News in another, as the Toolkit", async () => {
    const io = fakeIo({
      [REDDIT_FEED]: [ok(feed(entry("1", "A", "a"), entry("2", "B", "b", "cscareerquestions")))],
      [HACKER_NEWS_FEED]: [ok(JSON.stringify(hn))],
    });
    const reads = await readForums(io);
    expect(reads.map((r) => [r.forum, r.ok && r.threads.length])).toEqual([
      ["r/csMajors", 1],
      ["r/cscareerquestions", 1],
      ["Hacker News", 2],
    ]);
    expect(io.calls).toEqual([`${REDDIT_FEED} ${USER_AGENT}`, `${HACKER_NEWS_FEED} ${USER_AGENT}`]);
  });

  it("waits out Reddit's one-minute rate limit once and tries again", async () => {
    const io = fakeIo({
      [REDDIT_FEED]: [tooMany({ "x-ratelimit-reset": "59" }), ok(feed(entry("1", "A", "a")))],
      [HACKER_NEWS_FEED]: [ok(JSON.stringify(hn))],
    });
    const reads = await readForums(io);
    expect(io.slept).toEqual([59_000]);
    expect(reads[0]).toMatchObject({ forum: "r/csMajors", ok: true });
  });

  it("prefers Retry-After, and gives up on a wait over a minute", async () => {
    const io = fakeIo({
      [REDDIT_FEED]: [tooMany({ "retry-after": "600" })],
      [HACKER_NEWS_FEED]: [tooMany({ "retry-after": "2" }), ok(JSON.stringify(hn))],
    });
    const reads = await readForums(io);
    expect(io.slept).toEqual([2000]);
    expect(reads.map((r) => r.ok)).toEqual([false, false, true]);
  });

  it("reports each forum it could not read, plainly", async () => {
    const io = fakeIo({
      [REDDIT_FEED]: [tooMany(), tooMany()],
      [HACKER_NEWS_FEED]: [ok("not json")],
    });
    expect(await readForums(io)).toEqual([
      { forum: "r/csMajors", ok: false, error: "Reddit answered HTTP 429." },
      { forum: "r/cscareerquestions", ok: false, error: "Reddit answered HTTP 429." },
      { forum: "Hacker News", ok: false, error: "Hacker News sent data in an unexpected format." },
    ]);
    expect(io.slept).toEqual([5000]);
  });

  it("reports a forum that cannot be reached", async () => {
    const [read] = await readForums(fakeIo({}));
    expect(read).toEqual({
      forum: "r/csMajors",
      ok: false,
      error: "Reddit could not be reached: getaddrinfo ENOTFOUND.",
    });
  });
});
