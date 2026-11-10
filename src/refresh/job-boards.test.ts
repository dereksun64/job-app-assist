import { describe, expect, it } from "vitest";
import type { WatchedCompany } from "../contract/index.ts";
import { jobBoardApiUrl, readJobBoard, readWatchlist } from "./job-boards.ts";
import type { Fetch } from "./job-feed.ts";

const NOW = "2026-11-10T15:00:00.000Z";

const stripe: WatchedCompany = { name: "Stripe", board: "greenhouse", slug: "stripe" };
const palantir: WatchedCompany = { name: "Palantir", board: "lever", slug: "palantir" };
const openai: WatchedCompany = { name: "OpenAI", board: "ashby", slug: "openai" };

type Route = () => Response;

function fakeFetch(routes: Record<string, Route>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetch = (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) {
      return Promise.reject(
        new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }),
      );
    }
    return Promise.resolve(route());
  };
  return Object.assign(fetch, { calls });
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Trimmed from the live APIs on 2026-11-10.
const greenhouseBody = {
  jobs: [
    {
      absolute_url: "https://stripe.com/jobs/search?gh_jid=8172487",
      location: { name: "New York, NY; San Francisco, CA" },
      id: 8172487,
      updated_at: "2026-10-29T10:42:09-04:00",
      title: "Software Engineer, New Grad",
      company_name: "Stripe",
      first_published: "2026-09-03T13:30:34-04:00",
    },
    {
      absolute_url: "https://job-boards.greenhouse.io/stripe/jobs/1",
      location: { name: "Dublin" },
      id: 1,
      updated_at: "2026-10-29T10:42:09-04:00",
      title: "Abuse Investigator",
    },
  ],
  meta: { total: 2 },
};

const leverBody = [
  {
    categories: {
      commitment: "Internship",
      location: "New York, NY",
      team: "Engineering",
      allLocations: ["New York, NY", "Washington, D.C."],
    },
    createdAt: 1786469891368,
    id: "6ed76ce8",
    text: "Forward Deployed Software Engineer, Internship",
    workplaceType: "onsite",
    hostedUrl: "https://jobs.lever.co/palantir/6ed76ce8",
    applyUrl: "https://jobs.lever.co/palantir/6ed76ce8/apply",
  },
];

const ashbyBody = {
  apiVersion: "1",
  jobs: [
    {
      id: "8fb1615c",
      title: "Software Engineer, New Grad",
      employmentType: "FullTime",
      location: "San Francisco",
      secondaryLocations: [{ location: "New York City" }],
      publishedAt: "2026-11-05T02:20:02.702+00:00",
      isListed: true,
      workplaceType: "Hybrid",
      jobUrl: "https://jobs.ashbyhq.com/openai/8fb1615c",
      applyUrl: "https://jobs.ashbyhq.com/openai/8fb1615c/application",
    },
    {
      id: "hidden",
      title: "Unlisted role",
      location: "Remote",
      secondaryLocations: [],
      publishedAt: "2026-11-05T02:20:02.702+00:00",
      isListed: false,
      jobUrl: "https://jobs.ashbyhq.com/openai/hidden",
    },
    {
      id: "remote",
      title: "Research Engineer",
      employmentType: "Intern",
      location: "United States",
      secondaryLocations: [],
      publishedAt: "2026-11-01T00:00:00.000+00:00",
      isListed: true,
      workplaceType: "Remote",
      jobUrl: "https://jobs.ashbyhq.com/openai/remote",
    },
  ],
};

describe("jobBoardApiUrl", () => {
  it("reads each board from its public, keyless API", () => {
    expect(jobBoardApiUrl(stripe)).toBe("https://boards-api.greenhouse.io/v1/boards/stripe/jobs");
    expect(jobBoardApiUrl(palantir)).toBe("https://api.lever.co/v0/postings/palantir?mode=json");
    expect(jobBoardApiUrl(openai)).toBe("https://api.ashbyhq.com/posting-api/job-board/openai");
  });
});

describe("readJobBoard", () => {
  it("reads a Greenhouse board", async () => {
    const fetch = fakeFetch({ [jobBoardApiUrl(stripe)]: json(greenhouseBody) });
    expect(await readJobBoard(fetch, stripe, NOW)).toEqual({
      name: "Watchlist",
      list: "Stripe",
      ok: true,
      listsEveryLevel: true,
      fetchedAt: NOW,
      postings: [
        {
          applyUrl: "https://stripe.com/jobs/search?gh_jid=8172487",
          company: "Stripe",
          title: "Software Engineer, New Grad",
          location: "New York, NY; San Francisco, CA",
          jobType: "",
          age: "",
          postedAt: "2026-09-03T13:30:34-04:00",
          category: "",
          companyTier: "",
          list: "Stripe",
        },
        expect.objectContaining({
          title: "Abuse Investigator",
          postedAt: "2026-10-29T10:42:09-04:00",
        }),
      ],
    });
  });

  it("reads a Lever board, with every location and the commitment as the job type", async () => {
    const fetch = fakeFetch({ [jobBoardApiUrl(palantir)]: json(leverBody) });
    const result = await readJobBoard(fetch, palantir, NOW);
    expect(result.ok && result.postings).toEqual([
      {
        applyUrl: "https://jobs.lever.co/palantir/6ed76ce8",
        company: "Palantir",
        title: "Forward Deployed Software Engineer, Internship",
        location: "New York, NY; Washington, D.C.",
        jobType: "Internship",
        age: "",
        postedAt: "2026-08-11T17:38:11.368Z",
        category: "",
        companyTier: "",
        list: "Palantir",
      },
    ]);
  });

  it("reads an Ashby board, leaving out unlisted jobs and marking remote ones", async () => {
    const fetch = fakeFetch({ [jobBoardApiUrl(openai)]: json(ashbyBody) });
    const result = await readJobBoard(fetch, openai, NOW);
    expect(result.ok && result.postings).toEqual([
      expect.objectContaining({
        applyUrl: "https://jobs.ashbyhq.com/openai/8fb1615c",
        location: "San Francisco; New York City",
        jobType: "FullTime",
        postedAt: "2026-11-05T02:20:02.702+00:00",
      }),
      expect.objectContaining({
        applyUrl: "https://jobs.ashbyhq.com/openai/remote",
        location: "Remote in United States",
        jobType: "Intern",
      }),
    ]);
  });

  it("says plainly when the board does not exist", async () => {
    const fetch = fakeFetch({ [jobBoardApiUrl(stripe)]: json({}, 404) });
    expect(await readJobBoard(fetch, stripe, NOW)).toEqual({
      name: "Watchlist",
      list: "Stripe",
      ok: false,
      error:
        "Stripe has no public Greenhouse job board at https://job-boards.greenhouse.io/stripe. Check its link on the watchlist.",
    });
  });

  it.each<[string, Route, string]>([
    ["an HTTP error", json({}, 503), "Stripe's Greenhouse job board answered HTTP 503."],
    [
      "data in the wrong shape",
      json({ nope: true }),
      "Stripe's Greenhouse job board sent data in an unexpected format.",
    ],
    [
      "text that is not JSON",
      () => new Response("<html>"),
      "Stripe's Greenhouse job board sent data in an unexpected format.",
    ],
  ])("reports %s as a failing watchlist company", async (_label, route, error) => {
    const fetch = fakeFetch({ [jobBoardApiUrl(stripe)]: route });
    expect(await readJobBoard(fetch, stripe, NOW)).toEqual({
      name: "Watchlist",
      list: "Stripe",
      ok: false,
      error,
    });
  });

  it("reports a network failure as a failing watchlist company", async () => {
    expect(await readJobBoard(fakeFetch({}), stripe, NOW)).toEqual({
      name: "Watchlist",
      list: "Stripe",
      ok: false,
      error: "Stripe's Greenhouse job board could not be reached: getaddrinfo ENOTFOUND.",
    });
  });
});

describe("readWatchlist", () => {
  it("reads every company's board, in watchlist order", async () => {
    const fetch = fakeFetch({
      [jobBoardApiUrl(stripe)]: json(greenhouseBody),
      [jobBoardApiUrl(palantir)]: json(leverBody),
    });
    const results = await readWatchlist(fetch, [stripe, palantir, openai], NOW);
    expect(results.map((r) => [r.list, r.ok])).toEqual([
      ["Stripe", true],
      ["Palantir", true],
      ["OpenAI", false],
    ]);
    expect(fetch.calls).toHaveLength(3);
  });
});
