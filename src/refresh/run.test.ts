import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobListMeta, JobListPage, Settings } from "../contract/index.ts";
import { JOB_FEED_URL, parseJobFeed, readJobFeed, type Fetch } from "./job-feed.ts";
import { runRefreshCommand, type BatchWrite, type RefreshIo } from "./run.ts";
import { resolveShortLinks } from "./short-links.ts";

const NOW = "2026-11-10T15:00:00.000Z";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [{ name: "Software Engineer", priority: "high" }],
    seniority: ["intern", "new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City"] }],
  },
  dailyQueueTarget: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function job(overrides: Record<string, string> = {}) {
  return {
    age: "1d",
    applyUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
    category: "Software Engineering",
    company: "Acme",
    companyTier: "Unlisted",
    degreeLevel: "unknown",
    id: "a1",
    jobType: "full-time",
    location: "NYC",
    salary: "",
    source: "Simplify New Grad",
    sourceUrl: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md",
    title: "Software Engineer, New Grad",
    ...overrides,
  };
}

function feedJson(jobs: unknown[]) {
  return { count: jobs.length, generatedAt: "2026-11-10T12:00:00+00:00", jobs };
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[url];
    if (!route)
      return Promise.reject(
        new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }),
      );
    return Promise.resolve(route(url, init));
  };
  return Object.assign(fetch, { calls });
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

describe("parseJobFeed", () => {
  it("reads every Posting with its list, ages counted from when the feed was generated", () => {
    expect(parseJobFeed(feedJson([job()]), NOW)).toEqual({
      name: "Job Feed",
      ok: true,
      fetchedAt: "2026-11-10T12:00:00.000Z",
      postings: [
        {
          applyUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
          company: "Acme",
          title: "Software Engineer, New Grad",
          location: "NYC",
          jobType: "full-time",
          age: "1d",
          category: "Software Engineering",
          companyTier: "Unlisted",
          list: "Simplify New Grad",
        },
      ],
    });
  });

  it("skips entries without an apply URL, company or title", () => {
    const result = parseJobFeed(
      feedJson([job(), job({ applyUrl: "" }), job({ title: " " }), "junk"]),
      NOW,
    );
    expect(result.ok && result.postings).toHaveLength(1);
  });

  it("fails plainly on data in the wrong shape", () => {
    expect(parseJobFeed([job()], NOW)).toEqual({
      name: "Job Feed",
      ok: false,
      error: "The Job Feed's data is not in the expected format (no jobs list).",
    });
  });
});

describe("readJobFeed", () => {
  it("fetches the published Job Feed", async () => {
    const fetch = fakeFetch({ [JOB_FEED_URL]: json(feedJson([job()])) });
    const result = await readJobFeed(fetch, NOW);
    expect(result.ok).toBe(true);
    expect(fetch.calls).toEqual([`GET ${JOB_FEED_URL}`]);
  });

  it.each<[string, Route, string]>([
    ["an HTTP error", json({}, 503), "The Job Feed answered HTTP 503."],
    [
      "text that is not JSON",
      () => new Response("<html>"),
      "The Job Feed's data is not valid JSON.",
    ],
  ])("reports %s as a failing Source", async (_label, route, error) => {
    expect(await readJobFeed(fakeFetch({ [JOB_FEED_URL]: route }), NOW)).toEqual({
      name: "Job Feed",
      ok: false,
      error,
    });
  });

  it("reports a network failure as a failing Source", async () => {
    expect(await readJobFeed(fakeFetch({}), NOW)).toEqual({
      name: "Job Feed",
      ok: false,
      error: "The Job Feed could not be reached: getaddrinfo ENOTFOUND.",
    });
  });
});

describe("resolveShortLinks", () => {
  it("resolves each link with one unfollowed HEAD request", async () => {
    const fetch = fakeFetch({
      "https://go.vansh.nyc/a?s=A": redirect("https://jobs.lever.co/acme/1"),
    });
    expect(
      await resolveShortLinks(["https://go.vansh.nyc/a?s=A", "https://go.vansh.nyc/a?s=A"], {
        fetch,
      }),
    ).toEqual({
      resolved: { "https://go.vansh.nyc/a?s=A": "https://jobs.lever.co/acme/1" },
      failed: [],
    });
    expect(fetch.calls).toEqual(["HEAD https://go.vansh.nyc/a?s=A"]);
  });

  it("uses cached answers without asking again", async () => {
    const fetch = fakeFetch({});
    const cache = { "https://go.vansh.nyc/a": "https://jobs.lever.co/acme/1" };
    expect(await resolveShortLinks(["https://go.vansh.nyc/a"], { fetch, cache })).toEqual({
      resolved: cache,
      failed: [],
    });
    expect(fetch.calls).toEqual([]);
  });

  it("follows a short link that redirects to another short link", async () => {
    const fetch = fakeFetch({
      "https://go.vansh.nyc/a": redirect("/b"),
      "https://go.vansh.nyc/b": redirect("https://jobs.ashbyhq.com/acme/1"),
    });
    const { resolved } = await resolveShortLinks(["https://go.vansh.nyc/a"], { fetch });
    expect(resolved).toEqual({ "https://go.vansh.nyc/a": "https://jobs.ashbyhq.com/acme/1" });
  });

  it("lists links that do not redirect or cannot be reached as failed", async () => {
    const fetch = fakeFetch({
      "https://go.vansh.nyc/gone": () => new Response("Not found", { status: 404 }),
    });
    expect(
      await resolveShortLinks(["https://go.vansh.nyc/gone", "https://go.vansh.nyc/down"], {
        fetch,
      }),
    ).toEqual({
      resolved: {},
      failed: ["https://go.vansh.nyc/down", "https://go.vansh.nyc/gone"],
    });
  });
});

function memoryIo(files: Record<string, string>, fetch: Fetch) {
  const disk = new Map(Object.entries(files).map(([path, text]) => [resolve(path), text]));
  const io: RefreshIo & { out: string; err: string; disk: Map<string, string> } = {
    out: "",
    err: "",
    disk,
    readFile: (path) => {
      const text = disk.get(resolve(path));
      return text === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(text);
    },
    writeFile: (path, text) => {
      disk.set(resolve(path), text);
      return Promise.resolve();
    },
    readDir: (path) => {
      const prefix = `${resolve(path)}/`;
      return Promise.resolve(
        [...disk.keys()]
          .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .map((p) => p.slice(prefix.length)),
      );
    },
    makeDir: () => Promise.resolve(),
    removeDir: (path) => {
      for (const key of [...disk.keys()]) if (key.startsWith(`${resolve(path)}/`)) disk.delete(key);
      return Promise.resolve();
    },
    fetch,
    now: () => NOW,
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
  };
  return io;
}

const dir = "candidate/.job-app-assist/refresh";
const at = (...parts: string[]) => join(resolve(dir), ...parts);

// Parsed JSON is cast to the shape each test expects.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function readOut<T>(io: { disk: Map<string, string> }, ...parts: string[]): T {
  const text = io.disk.get(at(...parts));
  if (text === undefined) throw new Error(`missing ${parts.join("/")}`);
  return JSON.parse(text) as T;
}

describe("jaa refresh", () => {
  const feed = feedJson([
    job(),
    job({
      applyUrl: "https://go.vansh.nyc/z?s=y",
      company: "Zed",
      title: "Software Engineer Intern",
      jobType: "internship",
      source: "Vansh Internships",
    }),
    job({ applyUrl: "https://jobs.lever.co/far/1", company: "Far", location: "Denver, CO" }),
  ]);

  it("builds the Job List and writes documents plus ArtifactData batches", async () => {
    const fetch = fakeFetch({
      [JOB_FEED_URL]: json(feed),
      "https://go.vansh.nyc/z?s=y": redirect("https://jobs.ashbyhq.com/zed/9"),
    });
    const io = memoryIo({ [`${dir}/state/settings/main.json`]: JSON.stringify(settings) }, fetch);
    expect(await runRefreshCommand(dir, {}, io)).toBe(0);
    expect(io.err).toBe("");

    const { batches } = readOut<{ batches: BatchWrite[][] }>(io, "out", "writes.json");
    expect(batches).toEqual([
      [
        {
          op: "set",
          collection: "postings",
          doc_id: "page-1",
          file_path: at("out", "postings", "page-1.json"),
        },
        {
          op: "set",
          collection: "postings",
          doc_id: "meta",
          file_path: at("out", "postings", "meta.json"),
        },
      ],
    ]);
    const page = readOut<JobListPage>(io, "out", "postings", "page-1.json");
    expect(page.postings.map((p) => [p.company, p.applyUrl])).toEqual([
      ["Acme", "https://job-boards.greenhouse.io/acme/jobs/1"],
      ["Zed", "https://jobs.ashbyhq.com/zed/9"],
    ]);
    expect(readOut<JobListMeta>(io, "out", "postings", "meta.json")).toMatchObject({
      total: 2,
      refreshedAt: NOW,
    });
    expect(readOut<Record<string, string>>(io, "short-links.json")).toEqual({
      "https://go.vansh.nyc/z?s=y": "https://jobs.ashbyhq.com/zed/9",
    });
    expect(readOut<{ total: number }>(io, "out", "summary.json").total).toBe(2);

    expect(io.out).toContain(
      "Job List: 2 Postings (Tier 1: 2); 2 new and 0 gone since the last Refresh.",
    );
    expect(io.out).toContain("- Job Feed: read 3 Postings.");
    expect(io.out).toContain("Left out: 1 outside your Location Tiers");
    expect(io.out).toContain("1. Acme: Software Engineer, New Grad (New York, NY; Tier 1; score");
  });

  it("pins writes to the versions read and deletes documents the new Job List does not use", async () => {
    const fetch = fakeFetch({ [JOB_FEED_URL]: json(feedJson([job()])) });
    const oldMeta = {
      schemaVersion: 1,
      refreshedAt: "2026-11-09T15:00:00.000Z",
      pageCount: 2,
      total: 2,
      matched: 2,
      sources: [],
    };
    const io = memoryIo(
      {
        [`${dir}/state/settings/main.json`]: JSON.stringify(settings),
        [`${dir}/state/postings/meta.json`]: JSON.stringify(oldMeta),
        [`${dir}/state/postings/page-1.json`]: JSON.stringify({
          schemaVersion: 1,
          refreshedAt: oldMeta.refreshedAt,
          page: 1,
          postings: [],
        }),
        [`${dir}/state/postings/page-2.json`]: JSON.stringify({ old: "shape" }),
        [`${dir}/versions.json`]: JSON.stringify({
          "postings/meta": 7,
          "postings/page-1": 3,
          "postings/page-2": 2,
        }),
        [`${dir}/out/postings/page-9.json`]: "stale output",
      },
      fetch,
    );
    expect(await runRefreshCommand(dir, {}, io)).toBe(0);
    const { batches } = readOut<{ batches: BatchWrite[][] }>(io, "out", "writes.json");
    expect(batches[0]?.map(({ op, doc_id, if_version }) => [op, doc_id, if_version])).toEqual([
      ["set", "page-1", 3],
      ["set", "meta", 7],
      ["delete", "page-2", 2],
    ]);
    expect(io.disk.has(at("out", "postings", "page-9.json"))).toBe(false);
  });

  it("refuses to run without a version for every postings document read", async () => {
    const io = memoryIo(
      {
        [`${dir}/state/settings/main.json`]: JSON.stringify(settings),
        [`${dir}/state/postings/meta.json`]: "{}",
      },
      fakeFetch({}),
    );
    expect(await runRefreshCommand(dir, {}, io)).toBe(1);
    expect(io.err).toContain("versions.json has no version for postings/meta.");
  });

  it("asks for the settings document when it is missing or invalid", async () => {
    const missing = memoryIo({}, fakeFetch({}));
    expect(await runRefreshCommand(dir, {}, missing)).toBe(1);
    expect(missing.err).toContain("No settings at");

    const invalid = memoryIo(
      { [`${dir}/state/settings/main.json`]: JSON.stringify({ ...settings, dailyQueueTarget: 0 }) },
      fakeFetch({}),
    );
    expect(await runRefreshCommand(dir, {}, invalid)).toBe(1);
    expect(invalid.err).toContain("- dailyQueueTarget: must be at least 1");
  });

  it("reports a failing Job Feed plainly and still writes what it can", async () => {
    const io = memoryIo(
      { [`${dir}/state/settings/main.json`]: JSON.stringify(settings) },
      fakeFetch({ [JOB_FEED_URL]: json({}, 503) }),
    );
    expect(await runRefreshCommand(dir, {}, io)).toBe(0);
    expect(io.out).toContain("- Job Feed: FAILED. The Job Feed answered HTTP 503.");
    expect(readOut<JobListMeta>(io, "out", "postings", "meta.json").sources).toEqual([
      { name: "Job Feed", ok: false, postings: 0, error: "The Job Feed answered HTTP 503." },
    ]);
  });

  it("reads the Job Feed from a local file when asked", async () => {
    const io = memoryIo(
      {
        [`${dir}/state/settings/main.json`]: JSON.stringify(settings),
        "feed.json": JSON.stringify(feed),
      },
      fakeFetch({ "https://go.vansh.nyc/z?s=y": redirect("https://jobs.ashbyhq.com/zed/9") }),
    );
    expect(await runRefreshCommand(dir, { feed: "feed.json" }, io)).toBe(0);
    expect(io.out).toContain("- Job Feed: read 3 Postings.");
  });
});
