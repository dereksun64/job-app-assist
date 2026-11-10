import { describe, expect, it } from "vitest";
import { validateDocument } from "./index.ts";
import {
  ADDED_BY_URL_SOURCE_ID,
  JOB_FEED_SOURCE_ID,
  WATCHLIST_SOURCE_ID,
  defaultSourceSettings,
  jobBoardFromUrl,
  jobBoardUrl,
  readSourceSettings,
  type AddedByUrlSource,
  type WatchlistSource,
} from "./sources.ts";

const UPDATED = "2026-11-10T15:00:00.000Z";

function watchlist(overrides: Partial<WatchlistSource> = {}): WatchlistSource {
  return {
    schemaVersion: 1,
    enabled: true,
    companies: [
      { name: "Stripe", board: "greenhouse", slug: "stripe" },
      { name: "Palantir", board: "lever", slug: "palantir" },
      { name: "OpenAI", board: "ashby", slug: "openai" },
    ],
    updatedAt: UPDATED,
    ...overrides,
  };
}

function added(overrides: Partial<AddedByUrlSource> = {}): AddedByUrlSource {
  return {
    schemaVersion: 1,
    enabled: true,
    postings: [
      {
        url: "https://jobs.ashbyhq.com/acme/0d9a",
        company: "Acme",
        title: "Software Engineer, New Grad",
        location: "New York, NY",
        addedAt: UPDATED,
      },
    ],
    updatedAt: UPDATED,
    ...overrides,
  };
}

function issues(docId: string, input: unknown): string[] {
  const result = validateDocument("sources", docId, input);
  if (result.ok) throw new Error(`expected sources/${docId} to be rejected`);
  return result.issues;
}

describe("Source documents", () => {
  it("accepts the Job Feed with its switch", () => {
    const doc = { schemaVersion: 1, enabled: false, updatedAt: UPDATED };
    expect(validateDocument("sources", JOB_FEED_SOURCE_ID, doc)).toEqual({ ok: true, value: doc });
  });

  it("accepts a watchlist of companies on Greenhouse, Lever and Ashby", () => {
    expect(validateDocument("sources", WATCHLIST_SOURCE_ID, watchlist())).toEqual({
      ok: true,
      value: watchlist(),
    });
  });

  it("accepts Postings added by URL with the details the Candidate typed", () => {
    expect(validateDocument("sources", ADDED_BY_URL_SOURCE_ID, added())).toEqual({
      ok: true,
      value: added(),
    });
  });

  it("requires a switch on every Source", () => {
    const noSwitch: Partial<WatchlistSource> = watchlist();
    delete noSwitch.enabled;
    expect(issues(WATCHLIST_SOURCE_ID, noSwitch)).toEqual([expect.stringMatching(/^enabled: /)]);
  });

  it("rejects ids that are not one of the Sources", () => {
    expect(issues("linkedin", { schemaVersion: 1, enabled: true, updatedAt: UPDATED })).toEqual([
      'The sources collection holds "job-feed", "watchlist" and "added-by-url".',
    ]);
  });

  it("rejects job boards other than Greenhouse, Lever and Ashby", () => {
    const doc = watchlist({
      companies: [{ name: "Acme", board: "workday" as "lever", slug: "x" }],
    });
    expect(issues(WATCHLIST_SOURCE_ID, doc)).toEqual([
      expect.stringMatching(/^companies\.0\.board: /),
    ]);
  });

  it("rejects a job board slug that is not part of a web address", () => {
    const doc = watchlist({ companies: [{ name: "Acme", board: "lever", slug: "acme/../x" }] });
    expect(issues(WATCHLIST_SOURCE_ID, doc)).toEqual([
      "companies.0.slug: must be the company's name in its job board link, for example stripe",
    ]);
  });

  it("rejects the same job board on the watchlist twice", () => {
    const doc = watchlist({
      companies: [
        { name: "Stripe", board: "greenhouse", slug: "stripe" },
        { name: "Stripe again", board: "greenhouse", slug: "Stripe" },
      ],
    });
    expect(issues(WATCHLIST_SOURCE_ID, doc)).toEqual([
      "companies: Stripe again is already on the watchlist",
    ]);
  });

  it("rejects the same Posting added twice, however its URL is spelled", () => {
    const [first] = added().postings;
    if (!first) throw new Error("fixture needs a Posting");
    const doc = added({
      postings: [first, { ...first, url: `${first.url}/application?utm_source=x` }],
    });
    expect(issues(ADDED_BY_URL_SOURCE_ID, doc)).toEqual([
      "postings: https://jobs.ashbyhq.com/acme/0d9a/application?utm_source=x is already added",
    ]);
  });

  it("rejects an added Posting without a company, title or location", () => {
    const [first] = added().postings;
    if (!first) throw new Error("fixture needs a Posting");
    const doc = added({ postings: [{ ...first, company: " ", location: "" }] });
    expect(issues(ADDED_BY_URL_SOURCE_ID, doc)).toEqual([
      "postings.0.company: must not be blank",
      "postings.0.location: must not be blank",
    ]);
  });

  it("rejects an added URL that is not a web address", () => {
    const [first] = added().postings;
    if (!first) throw new Error("fixture needs a Posting");
    expect(
      issues(ADDED_BY_URL_SOURCE_ID, added({ postings: [{ ...first, url: "acme" }] })),
    ).toEqual(["postings.0.url: must be an http or https web address"]);
  });
});

describe("readSourceSettings", () => {
  it("starts every Candidate with all Sources on and nothing on the watchlist", () => {
    expect(readSourceSettings([])).toEqual({ settings: defaultSourceSettings(), issues: [] });
    expect(defaultSourceSettings()).toEqual({
      jobFeed: { enabled: true },
      watchlist: { enabled: true, companies: [] },
      addedByUrl: { enabled: true, postings: [] },
    });
  });

  it("reads each Source document over the defaults", () => {
    const { settings } = readSourceSettings([
      { id: JOB_FEED_SOURCE_ID, data: { schemaVersion: 1, enabled: false, updatedAt: UPDATED } },
      { id: WATCHLIST_SOURCE_ID, data: watchlist() },
    ]);
    expect(settings.jobFeed.enabled).toBe(false);
    expect(settings.watchlist.companies.map((c) => c.name)).toEqual([
      "Stripe",
      "Palantir",
      "OpenAI",
    ]);
    expect(settings.addedByUrl).toEqual({ enabled: true, postings: [] });
  });

  it("reports a document outside the contract and leaves that Source off", () => {
    const result = readSourceSettings([
      { id: WATCHLIST_SOURCE_ID, data: { ...watchlist(), enabled: "yes" } },
      { id: "notes", data: {} },
    ]);
    expect(result.settings.watchlist).toEqual({ enabled: false, companies: [] });
    expect(result.issues).toEqual([
      "sources/watchlist: enabled: Invalid input: expected boolean, received string",
    ]);
  });
});

describe("job board links", () => {
  it.each([
    ["https://job-boards.greenhouse.io/stripe", "greenhouse", "stripe"],
    ["https://boards.greenhouse.io/stripe/jobs/8172487?gh_src=x", "greenhouse", "stripe"],
    ["https://boards.greenhouse.io/embed/job_board?for=acme", "greenhouse", "acme"],
    ["https://boards-api.greenhouse.io/v1/boards/acme/jobs", "greenhouse", "acme"],
    ["https://jobs.lever.co/palantir", "lever", "palantir"],
    ["jobs.lever.co/palantir/6ed76ce8-4156/apply", "lever", "palantir"],
    ["https://jobs.ashbyhq.com/openai", "ashby", "openai"],
    ["https://jobs.ashbyhq.com/Notion/8fb1615c/application", "ashby", "Notion"],
  ])("reads %s as %s/%s", (url, board, slug) => {
    expect(jobBoardFromUrl(url)).toEqual({ board, slug });
  });

  it.each([
    "https://stripe.com/jobs",
    "https://acme.wd5.myworkdayjobs.com/External",
    "https://jobs.lever.co/",
    "not a link",
  ])("finds no job board in %s", (url) => {
    expect(jobBoardFromUrl(url)).toBeUndefined();
  });

  it("links each job board for the Candidate to open", () => {
    expect(jobBoardUrl({ board: "greenhouse", slug: "stripe" })).toBe(
      "https://job-boards.greenhouse.io/stripe",
    );
    expect(jobBoardUrl({ board: "lever", slug: "palantir" })).toBe(
      "https://jobs.lever.co/palantir",
    );
    expect(jobBoardUrl({ board: "ashby", slug: "openai" })).toBe("https://jobs.ashbyhq.com/openai");
  });
});
