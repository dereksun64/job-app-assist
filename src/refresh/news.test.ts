import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Card, JobListMeta, JobListPage, NewsDigest, Posting } from "../contract/index.ts";
import { sampleDigest, sampleForumHighlight, samplePosting } from "../contract/testing/fixtures.ts";
import type { NewsPlan } from "../engine/news.ts";
import type { BatchWrite } from "./run.ts";
import { HACKER_NEWS_FEED } from "./forums.ts";
import type { Fetch } from "./job-feed.ts";
import { runNewsCommand, type NewsPlanFile } from "./news.ts";
import { memoryIo, type MemoryIo } from "./testing/memory-io.ts";

// 01:00 UTC on Nov 11 is still Nov 10 in New York.
const NOW = "2026-11-11T01:00:00.000Z";
const DAY = "2026-11-10";
const dir = "candidate/.job-app-assist/refresh";
const at = (...parts: string[]) => join(resolve(dir), ...parts);
const file = (...parts: string[]) => `${dir}/${parts.join("/")}`;
const REFRESHED = "2026-11-11T00:55:00.000Z";

const google = samplePosting({
  id: "00000000000a",
  company: "Google",
  boosts: ["Fortune 500"],
  postedOn: "2026-11-09",
  applyUrl: "https://careers.google.com/jobs/1",
});
const acme = samplePosting({ id: "00000000000b", company: "Acme", boosts: [] });

function jobList(postings: Posting[], refreshedAt = REFRESHED): Record<string, string> {
  const page: JobListPage = { schemaVersion: 1, refreshedAt, page: 1, postings };
  const meta: JobListMeta = {
    schemaVersion: 1,
    refreshedAt,
    pageCount: 1,
    total: postings.length,
    matched: postings.length,
    sources: [],
  };
  return { "page-1.json": JSON.stringify(page), "meta.json": JSON.stringify(meta) };
}

function card(of: Posting): Card {
  return {
    schemaVersion: 1,
    postingId: of.id,
    stage: "queued",
    queuedAt: REFRESHED,
    queuedBy: "refresh",
    posting: of,
    updatedAt: REFRESHED,
  };
}

function under(folder: string, docs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(docs).map(([name, text]) => [file(folder, name), text]));
}

// Parsed JSON is cast to the shape each test expects.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function readOut<T>(io: MemoryIo, ...parts: string[]): T {
  const text = io.disk.get(at(...parts));
  if (text === undefined) throw new Error(`missing ${parts.join("/")}`);
  return JSON.parse(text) as T;
}

const run = (io: MemoryIo, step: "plan" | "build") => runNewsCommand(step, dir, io);

function gathered(): Pick<NewsDigest, "forumHighlights" | "companyNews" | "industryNews" | "gaps"> {
  const { forumHighlights, companyNews, industryNews, gaps } = sampleDigest();
  return { forumHighlights, companyNews, industryNews, gaps };
}

describe("jaa news plan", () => {
  it("computes hiring signals from the Job List Refresh just wrote and lists the Queue companies", async () => {
    const io = memoryIo(
      {
        ...under("state/postings", jobList([acme], "2026-11-09T12:00:00.000Z")),
        ...under("out/postings", jobList([google, acme])),
        ...under("state/cards", { [`${acme.id}.json`]: JSON.stringify(card(acme)) }),
        ...under("out/cards", { [`${google.id}.json`]: JSON.stringify(card(google)) }),
      },
      { now: NOW, timeZone: "America/New_York" },
    );
    expect(await run(io, "plan")).toBe(0);
    const plan = readOut<NewsPlan>(io, "out", "news-plan.json");
    expect(plan.day).toBe(DAY);
    expect(plan.newThisWeek).toBe(2);
    expect(plan.hiringSignals.map((s) => s.company)).toEqual(["Google"]);
    expect(plan.queueCompanies).toEqual(["Acme", "Google"]);
    expect(io.out).toContain("News Digest for Tuesday, November 10, 2026");
    expect(io.out).toContain("Hiring signals: 1 company (Google, 1 new Posting)");
    expect(io.out).toContain("Companies in the Queue: Acme, Google");
    expect(io.out).toContain(at("out", "news-gathered.json"));
  });

  it("falls back to the Job List in the dashboard when Refresh wrote none", async () => {
    const io = memoryIo(under("state/postings", jobList([google])), { now: NOW });
    expect(await run(io, "plan")).toBe(0);
    expect(readOut<NewsPlan>(io, "out", "news-plan.json").hiringSignals).toHaveLength(1);
  });

  it("ignores Job List pages from another Refresh than the meta document's", async () => {
    const io = memoryIo(
      {
        ...under("out/postings", {
          ...jobList([acme]),
          "page-1.json": JSON.stringify({
            schemaVersion: 1,
            refreshedAt: "2026-11-01T00:00:00.000Z",
            page: 1,
            postings: [google],
          }),
        }),
      },
      { now: NOW },
    );
    expect(await run(io, "plan")).toBe(0);
    expect(readOut<NewsPlan>(io, "out", "news-plan.json").newThisWeek).toBe(0);
  });

  it("lists the sources the past week's digests already linked", async () => {
    const yesterday = sampleDigest({ day: "2026-11-09" });
    const io = memoryIo(under("state/news", { "2026-11-09.json": JSON.stringify(yesterday) }), {
      now: NOW,
      timeZone: "America/New_York",
    });
    expect(await run(io, "plan")).toBe(0);
    expect(readOut<NewsPlan>(io, "out", "news-plan.json").recentUrls).toContain(
      yesterday.industryNews[0]?.url,
    );
    expect(io.out).toContain("Already linked this week: 8 sources");
  });

  it("reads the forums' threads into the plan, and names each forum it could not read", async () => {
    const hn = { hits: [{ objectID: "7", title: "Ask HN: Who is hiring?", points: 9 }] };
    const fetch: Fetch = (url) =>
      Promise.resolve(
        url === HACKER_NEWS_FEED
          ? new Response(JSON.stringify(hn))
          : new Response("", { status: 403 }),
      );
    const io = memoryIo({}, { now: NOW, fetch });
    expect(await run(io, "plan")).toBe(0);
    const { forums } = readOut<NewsPlanFile>(io, "out", "news-plan.json");
    expect(forums).toEqual([
      { forum: "r/csMajors", ok: false, error: "Reddit answered HTTP 403." },
      { forum: "r/cscareerquestions", ok: false, error: "Reddit answered HTTP 403." },
      {
        forum: "Hacker News",
        ok: true,
        threads: [
          {
            title: "Ask HN: Who is hiring?",
            url: "https://news.ycombinator.com/item?id=7",
            postedAt: "",
            points: 9,
          },
        ],
      },
    ]);
    expect(io.out).toContain("- r/csMajors: FAILED. Reddit answered HTTP 403.");
    expect(io.out).toContain(
      `- Hacker News: 1 thread, under forums in ${at("out", "news-plan.json")}.`,
    );
  });

  it("says plainly when the Queue is empty", async () => {
    const io = memoryIo({}, { now: NOW });
    expect(await run(io, "plan")).toBe(0);
    expect(io.out).toContain("Companies in the Queue: none, so leave companyNews empty.");
  });
});

describe("jaa news build", () => {
  async function planned(files: Record<string, string> = {}) {
    const io = memoryIo(
      {
        ...under("out/postings", jobList([google, acme])),
        ...under("state/cards", { [`${acme.id}.json`]: JSON.stringify(card(acme)) }),
        ...files,
      },
      { now: NOW, timeZone: "America/New_York" },
    );
    expect(await run(io, "plan")).toBe(0);
    io.out = "";
    return io;
  }

  it("writes one digest for the day and an ArtifactData batch for it", async () => {
    const io = await planned({ [file("out/news-gathered.json")]: JSON.stringify(gathered()) });
    expect(await run(io, "build")).toBe(0);
    const digest = readOut<NewsDigest>(io, "out", "news", `${DAY}.json`);
    expect(digest).toMatchObject({ day: DAY, builtAt: NOW, newThisWeek: 2, ...gathered() });
    expect(digest.hiringSignals.map((s) => s.company)).toEqual(["Google"]);
    expect(readOut<{ batches: BatchWrite[][] }>(io, "out", "news-writes.json")).toEqual({
      batches: [
        [
          {
            op: "set",
            collection: "news",
            doc_id: DAY,
            file_path: at("out", "news", `${DAY}.json`),
          },
        ],
      ],
    });
    expect(io.out).toContain(
      "News Digest for Tuesday, November 10, 2026: 1 hiring signal, 2 forum highlights, 1 company news item, 5 industry stories.",
    );
    expect(io.err).toBe("");
  });

  it("rewrites today's digest with its version and removes digests past 90 days", async () => {
    const io = await planned({
      [file("out/news-gathered.json")]: JSON.stringify(gathered()),
      [file("versions.json")]: JSON.stringify({ [`news/${DAY}`]: 3, "news/2026-08-01": 1 }),
      ...under("state/news", {
        [`${DAY}.json`]: JSON.stringify(sampleDigest({ day: DAY })),
        "2026-08-01.json": JSON.stringify(sampleDigest({ day: "2026-08-01" })),
        "2026-10-01.json": JSON.stringify(sampleDigest({ day: "2026-10-01" })),
      }),
    });
    expect(await run(io, "build")).toBe(0);
    expect(readOut<{ batches: BatchWrite[][] }>(io, "out", "news-writes.json").batches).toEqual([
      [
        {
          op: "set",
          collection: "news",
          doc_id: DAY,
          file_path: at("out", "news", `${DAY}.json`),
          if_version: 3,
        },
        { op: "delete", collection: "news", doc_id: "2026-08-01", if_version: 1 },
      ],
    ]);
    expect(io.out).toContain("Removing 1 digest older than 90 days.");
  });

  it("lists every problem in the gathered news and writes nothing", async () => {
    const news = gathered();
    news.industryNews = news.industryNews.slice(0, 3);
    news.forumHighlights = [
      sampleForumHighlight({ url: "https://www.teamblind.com/post/new-grad-offers" }),
    ];
    const io = await planned({ [file("out/news-gathered.json")]: JSON.stringify(news) });
    expect(await run(io, "build")).toBe(1);
    expect(io.err).toBe(
      [
        `The News Digest in ${at("out", "news-gathered.json")} does not match the dashboard contract:`,
        "- forumHighlights.0.url: must not link to teamblind.com; the digest never reads LinkedIn or Blind",
        "- forumHighlights.0.url: must be a r/csMajors thread, like https://www.reddit.com/r/csMajors/comments/...",
        "- industryNews: list 5 to 8 industry stories, or none with a gap that says why",
        "Fix those entries and run jaa news build again.",
        "",
      ].join("\n"),
    );
    expect(io.disk.has(at("out", "news-writes.json"))).toBe(false);
  });

  it("asks for the plan first", async () => {
    const io = memoryIo({}, { now: NOW });
    expect(await run(io, "build")).toBe(1);
    expect(io.err).toContain("Run jaa news plan");
  });

  it("asks for the gathered news when it is missing or not JSON", async () => {
    const io = await planned();
    expect(await run(io, "build")).toBe(1);
    expect(io.err).toContain(`No gathered news at ${at("out", "news-gathered.json")}`);
    io.err = "";
    io.disk.set(at("out", "news-gathered.json"), "{");
    expect(await run(io, "build")).toBe(1);
    expect(io.err).toContain("is not valid JSON");
  });
});
