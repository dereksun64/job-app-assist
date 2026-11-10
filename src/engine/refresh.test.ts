import { describe, expect, it } from "vitest";
import {
  MAX_JOB_LIST,
  POSTINGS_PER_PAGE,
  validateDocument,
  type JobListMeta,
  type JobListPage,
  type Posting,
  type Settings,
} from "../contract/index.ts";
import {
  runRefresh,
  shortLinksToResolve,
  type CurrentJobList,
  type RefreshInput,
} from "./refresh.ts";
import type { SourcePosting, SourceResult } from "./source.ts";

const NOW = "2026-11-10T15:00:00.000Z";
const GENERATED = "2026-11-10T12:00:00.000Z";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "high" },
      { name: "Product Manager", priority: "low" },
    ],
    seniority: ["intern", "new_grad", "junior"],
    startWindow: { earliest: "2027-01", latest: "2027-12" },
    locationTiers: [{ locations: ["New York City", "Remote"] }, { locations: ["Boston"] }],
  },
  dailyQueueTarget: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

let counter = 0;
function listed(overrides: Partial<SourcePosting> = {}): SourcePosting {
  counter += 1;
  return {
    applyUrl: `https://job-boards.greenhouse.io/company${String(counter)}/jobs/${String(counter)}`,
    company: `Company ${String(counter)}`,
    title: "Software Engineer, New Grad",
    location: "New York, NY",
    jobType: "full-time",
    age: "2d",
    category: "Software Engineering",
    companyTier: "Unlisted",
    list: "Simplify New Grad",
    ...overrides,
  };
}

function feed(postings: SourcePosting[]): SourceResult {
  return { name: "Job Feed", ok: true, fetchedAt: GENERATED, postings };
}

const empty: CurrentJobList = { pages: [] };

function refresh(postings: SourcePosting[], overrides: Partial<RefreshInput> = {}) {
  return runRefresh({
    now: NOW,
    settings,
    sources: [feed(postings)],
    current: empty,
    ...overrides,
  });
}

function titles(postings: readonly Posting[]): string[] {
  return postings.map((p) => `${p.company}: ${p.title}`);
}

describe("filtering by the Search Profile", () => {
  it("keeps Postings that match role type, seniority, start window and a Location Tier", () => {
    const { jobList } = refresh([listed({ company: "Acme" })]);
    expect(jobList).toEqual([
      expect.objectContaining({
        company: "Acme",
        title: "Software Engineer, New Grad",
        locations: ["New York, NY"],
        locationTier: 1,
        roleType: "Software Engineer",
        level: "new_grad",
        postedOn: "2026-11-08",
        sources: [{ name: "Job Feed", list: "Simplify New Grad" }],
      }),
    ]);
  });

  it("drops each kind of mismatch and counts why", () => {
    const { jobList, summary } = refresh([
      listed({ company: "Keep" }),
      listed({ company: "Austin", location: "Austin, TX" }),
      listed({ company: "Senior", title: "Senior Software Engineer" }),
      listed({
        company: "Past",
        title: "Software Engineer Intern - Summer 2026",
        jobType: "internship",
      }),
      listed({ company: "Accounting", title: "Accounting Analyst, New Grad" }),
    ]);
    expect(jobList.map((p) => p.company)).toEqual(["Keep"]);
    expect(summary.filteredOut).toEqual({ location: 1, seniority: 1, startWindow: 1, roleType: 1 });
  });

  it("drops levels outside the Candidate's seniority", () => {
    const newGradOnly: Settings = {
      ...settings,
      searchProfile: { ...settings.searchProfile, seniority: ["new_grad"] },
    };
    const { jobList } = refresh(
      [
        listed({ company: "Grad" }),
        listed({ company: "Intern", title: "Software Engineer Intern", jobType: "internship" }),
        listed({ company: "Junior", title: "Software Engineer I" }),
      ],
      { settings: newGradOnly },
    );
    expect(jobList.map((p) => p.company)).toEqual(["Grad"]);
  });

  it("reads a new-grad role the Source lists as an internship as new grad", () => {
    const { jobList } = refresh([
      listed({
        title: "Engineer 2 New Grad - Multiple Teams",
        jobType: "internship",
        list: "Simplify Internships",
      }),
    ]);
    expect(jobList[0]?.level).toBe("new_grad");
  });

  it("gives a multi-location Posting its best Location Tier and every location, best first", () => {
    const { jobList } = refresh([listed({ location: "3 locationsAustin, TXBoston, MANYC" })]);
    expect(jobList[0]).toMatchObject({
      locations: ["New York, NY", "Boston, MA", "Austin, TX"],
      locationTier: 1,
    });
  });

  it("never stores Postings that matched nothing, so the Job List is not the whole feed", () => {
    const feedPostings = Array.from({ length: 50 }, (_, i) =>
      listed({ location: i < 5 ? "NYC" : "Denver, CO" }),
    );
    const { jobList, meta } = refresh(feedPostings);
    expect(jobList).toHaveLength(5);
    expect(meta).toMatchObject({ total: 5, matched: 5 });
    expect(meta.sources).toEqual([{ name: "Job Feed", ok: true, postings: 50 }]);
  });
});

describe("dedupe", () => {
  it("merges Postings with the same apply URL once tracking parameters are ignored", () => {
    const { jobList } = refresh([
      listed({
        applyUrl: "https://jobs.lever.co/acme/1/apply?utm_source=Simplify",
        company: "Acme",
        list: "Simplify New Grad",
        age: "3d",
      }),
      listed({
        applyUrl: "https://jobs.lever.co/acme/1",
        company: "Acme Inc.",
        title: "Software Engineer (New Grad)",
        list: "Vansh New Grad",
        age: "1d",
        companyTier: "Tier 2",
      }),
    ]);
    expect(jobList).toHaveLength(1);
    expect(jobList[0]).toMatchObject({
      applyUrl: "https://jobs.lever.co/acme/1",
      sources: [
        { name: "Job Feed", list: "Simplify New Grad" },
        { name: "Job Feed", list: "Vansh New Grad" },
      ],
      postedOn: "2026-11-07",
      boosts: ["Company tier 2"],
    });
  });

  it("merges Postings from different lists with the same company, title and location", () => {
    const { jobList } = refresh([
      listed({
        applyUrl: "https://acme.wd5.myworkdayjobs.com/x/job/1",
        company: "🔥 Acme",
        title: "Software Engineer, New Grad 🎓",
        location: "NYC",
        list: "Simplify New Grad",
      }),
      listed({
        applyUrl: "https://job-boards.greenhouse.io/acme/jobs/9",
        company: "Acme, Inc.",
        title: "Software Engineer - New Grad",
        location: "New York, NY",
        list: "Vansh New Grad",
      }),
    ]);
    expect(jobList).toHaveLength(1);
    expect(jobList[0]?.sources).toHaveLength(2);
  });

  it("merges one job a list gives on two career sites", () => {
    const { jobList } = refresh(
      [
        listed({
          applyUrl:
            "https://verizon.wd12.myworkdayjobs.com/verizon-careers/job/NJ/Engineer_R-1103369-1",
          company: "Verizon",
          title: "Engineer - Full Stack",
          location: "Basking Ridge, NJ",
        }),
        listed({
          applyUrl:
            "https://verizon.wd12.myworkdayjobs.com/frontier_career_site/job/NJ/Engineer_R-1103369",
          company: "Verizon",
          title: "Engineer - Full Stack",
          location: "Basking Ridge, NJ",
        }),
      ],
      {
        settings: {
          ...settings,
          searchProfile: {
            ...settings.searchProfile,
            locationTiers: [{ locations: ["New Jersey"] }],
          },
        },
      },
    );
    expect(jobList).toHaveLength(1);
  });

  it("takes a readable company name from a duplicate when a Source gives an id", () => {
    const { jobList } = refresh([
      listed({
        applyUrl: "https://jobs.ashbyhq.com/f7d8749a/1",
        company: "F7d8749a 72d6 407c Bf98 292ea630c73a",
      }),
      listed({
        applyUrl: "https://jobs.ashbyhq.com/f7d8749a/1?embed=true",
        company: "Shield AI",
        list: "Vansh New Grad",
      }),
      listed({
        applyUrl: "https://jobs.ashbyhq.com/f7d8749a/2",
        company: "F7d8749a 72d6 407c Bf98 292ea630c73a",
        title: "Backend Engineer, New Grad",
      }),
    ]);
    expect(jobList.map((p) => p.company).sort()).toEqual(["Shield AI", "Unknown company"]);
  });

  it("merges chains of duplicates that share a URL with one and a title with another", () => {
    const { jobList } = refresh([
      listed({
        applyUrl: "https://jobs.lever.co/acme/1",
        company: "Acme",
        title: "Backend Engineer, New Grad",
        list: "A",
      }),
      listed({
        applyUrl: "https://jobs.lever.co/acme/1/apply",
        company: "Acme",
        title: "Software Engineer, Backend",
        list: "B",
      }),
      listed({
        applyUrl: "https://jobs.ashbyhq.com/acme/77",
        company: "Acme",
        title: "Software Engineer, Backend",
        list: "C",
      }),
    ]);
    expect(jobList).toHaveLength(1);
    expect(jobList[0]?.sources.map((s) => s.list)).toEqual(["A", "B", "C"]);
  });

  it("treats Remote and Remote in USA as the same place when merging", () => {
    const { jobList } = refresh(
      [
        listed({
          company: "CACI",
          title: "Junior Software Developer",
          location: "Remote in USA",
          list: "A",
        }),
        listed({
          company: "CACI",
          title: "Junior Software Developer",
          location: "Remote",
          list: "B",
        }),
        listed({
          company: "CACI",
          title: "Junior Software Developer",
          location: "Remote in UK",
          list: "C",
        }),
      ],
      {
        settings: {
          ...settings,
          searchProfile: {
            ...settings.searchProfile,
            locationTiers: [{ locations: ["Remote", "Remote in UK"] }],
          },
        },
      },
    );
    expect(jobList.map((p) => p.locations[0]).sort()).toEqual(["Remote in UK", "Remote in USA"]);
  });

  it("keeps the same title at one company in different locations apart", () => {
    const { jobList } = refresh([
      listed({ company: "Acme", location: "NYC" }),
      listed({ company: "Acme", location: "Boston, MA" }),
    ]);
    expect(jobList).toHaveLength(2);
  });

  it("dedupes short links by where they resolve", () => {
    const short1 = "https://go.vansh.nyc/1rE?s=A";
    const short2 = "https://go.vansh.nyc/9zZ?s=B";
    const postings = [
      listed({
        applyUrl: short1,
        company: "Zingage",
        title: "Software Engineer, New Grad",
        list: "Vansh New Grad",
      }),
      listed({
        applyUrl: short2,
        company: "Zingage",
        title: "New Grad SWE",
        list: "Vansh Internships",
      }),
      listed({
        applyUrl: "https://jobs.dover.com/zingage/9f37?utm_source=x",
        company: "Zingage",
        title: "SWE",
        list: "Simplify New Grad",
      }),
    ];
    const target = "https://jobs.dover.com/zingage/9f37";
    const { jobList, summary } = refresh(postings, {
      resolvedLinks: { [short1]: target, [short2]: target },
    });
    expect(jobList).toHaveLength(1);
    expect(jobList[0]?.applyUrl).toBe(target);
    expect(summary.unresolvedLinks).toBe(0);
  });

  it("keeps an unresolved short link as the apply URL and counts it", () => {
    const { jobList, summary } = refresh([listed({ applyUrl: "https://go.vansh.nyc/1rE?s=A" })]);
    expect(jobList[0]?.applyUrl).toBe("https://go.vansh.nyc/1rE");
    expect(summary.unresolvedLinks).toBe(1);
  });
});

describe("short links to resolve", () => {
  it("asks only for short links of Postings that match the Search Profile, once each", () => {
    const links = shortLinksToResolve({
      now: NOW,
      settings,
      current: empty,
      sources: [
        feed([
          listed({ applyUrl: "https://go.vansh.nyc/a?s=A" }),
          listed({ applyUrl: "https://go.vansh.nyc/a?s=A" }),
          listed({ applyUrl: "https://go.vansh.nyc/b?s=A", location: "Denver, CO" }),
          listed({ applyUrl: "https://jobs.lever.co/acme/1" }),
        ]),
      ],
    });
    expect(links).toEqual(["https://go.vansh.nyc/a?s=A"]);
  });
});

describe("ranking", () => {
  it("ranks within a Location Tier by fit, company boost and freshness", () => {
    const { jobList } = refresh([
      listed({ company: "Plain", age: "2d" }),
      listed({ company: "Stale", age: "2mo" }),
      listed({ company: "Walmart", age: "2d" }),
      listed({ company: "OpenAI", age: "2d", companyTier: "Tier 1" }),
      listed({ company: "PM", title: "Associate Product Manager, New Grad", age: "0d" }),
    ]);
    expect(jobList.map((p) => p.company)).toEqual(["OpenAI", "Walmart", "Plain", "Stale", "PM"]);
    const scores = jobList.map((p) => p.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(jobList[0]?.boosts).toEqual(["Company tier 1"]);
  });

  it("scores from 0 to 100", () => {
    const { jobList } = refresh([
      listed({ company: "Google", companyTier: "Tier 1", age: "0d" }),
      listed({ company: "Nobody", title: "Associate Product Manager", age: "1y" }),
    ]);
    expect(jobList.map((p) => p.score)).toEqual([100, 13]);
  });

  it("lists every Tier 1 Posting before any Tier 2 Posting, however strong", () => {
    const { jobList, summary } = refresh([
      listed({ company: "Boston Star", location: "Boston, MA", companyTier: "Tier 1", age: "0d" }),
      listed({
        company: "NYC Weak",
        location: "NYC",
        title: "Associate Product Manager",
        age: "3mo",
      }),
      listed({ company: "Remote Plain", location: "Remote in USA" }),
    ]);
    expect(jobList.map((p) => [p.company, p.locationTier])).toEqual([
      ["Remote Plain", 1],
      ["NYC Weak", 1],
      ["Boston Star", 2],
    ]);
    expect(summary.byTier).toEqual([2, 1]);
  });

  it("orders ties the same way every time", () => {
    const postings = [
      listed({ company: "Beta", applyUrl: "https://a.example.com/2" }),
      listed({ company: "Alpha", applyUrl: "https://a.example.com/1" }),
    ];
    expect(titles(refresh(postings).jobList)).toEqual(
      titles(refresh([...postings].reverse()).jobList),
    );
    expect(refresh(postings).jobList.map((p) => p.company)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps only the best-ranked Postings past the Job List limit", () => {
    const many = Array.from({ length: MAX_JOB_LIST + 7 }, (_, i) =>
      listed({ age: `${String(i % 60)}d` }),
    );
    const { jobList, meta, summary } = refresh(many);
    expect(jobList).toHaveLength(MAX_JOB_LIST);
    expect(meta).toMatchObject({ total: MAX_JOB_LIST, matched: MAX_JOB_LIST + 7 });
    expect(summary.matched).toBe(MAX_JOB_LIST + 7);
    expect(Math.min(...jobList.map((p) => p.score))).toBeGreaterThanOrEqual(
      Math.max(...jobList.slice(-1).map((p) => p.score)),
    );
  });
});

function page(
  n: number,
  postings: Posting[],
  refreshedAt = "2026-11-09T15:00:00.000Z",
): JobListPage {
  return { schemaVersion: 1, refreshedAt, page: n, postings };
}

function metaFor(total: number, sources: JobListMeta["sources"] = []): JobListMeta {
  return {
    schemaVersion: 1,
    refreshedAt: "2026-11-09T15:00:00.000Z",
    pageCount: Math.ceil(total / POSTINGS_PER_PAGE),
    total,
    matched: total,
    sources,
  };
}

describe("change set", () => {
  it("writes the Job List as rank-ordered pages and a meta document, all valid", () => {
    const postings = Array.from({ length: POSTINGS_PER_PAGE + 3 }, () => listed());
    const { changeSet, jobList } = refresh(postings);
    expect(changeSet.set.map((w) => `${w.collection}/${w.docId}`)).toEqual([
      "postings/page-1",
      "postings/page-2",
      "postings/meta",
    ]);
    expect(changeSet.delete).toEqual([]);
    for (const write of changeSet.set) {
      expect(validateDocument(write.collection, write.docId, write.data)).toMatchObject({
        ok: true,
      });
    }
    const [first, second, meta] = changeSet.set.map((w) => w.data);
    expect(first).toMatchObject({ page: 1, refreshedAt: NOW });
    expect((first as JobListPage).postings).toEqual(jobList.slice(0, POSTINGS_PER_PAGE));
    expect((second as JobListPage).postings).toEqual(jobList.slice(POSTINGS_PER_PAGE));
    expect(meta).toEqual({
      schemaVersion: 1,
      refreshedAt: NOW,
      pageCount: 2,
      total: POSTINGS_PER_PAGE + 3,
      matched: POSTINGS_PER_PAGE + 3,
      sources: [{ name: "Job Feed", ok: true, postings: POSTINGS_PER_PAGE + 3 }],
    });
  });

  it("deletes pages the shorter Job List no longer needs", () => {
    const old = refresh(Array.from({ length: POSTINGS_PER_PAGE * 2 + 1 }, () => listed())).jobList;
    const current: CurrentJobList = {
      meta: metaFor(old.length),
      pages: [page(1, old.slice(0, 200)), page(2, old.slice(200, 400)), page(3, old.slice(400))],
    };
    const { changeSet } = refresh([listed()], { current });
    expect(changeSet.set.map((w) => w.docId)).toEqual(["page-1", "meta"]);
    expect(changeSet.delete).toEqual([
      { collection: "postings", docId: "page-2" },
      { collection: "postings", docId: "page-3" },
    ]);
  });

  it("writes an empty Job List as a meta document alone", () => {
    const { changeSet, meta } = refresh([listed({ location: "Denver, CO" })]);
    expect(changeSet.set.map((w) => w.docId)).toEqual(["meta"]);
    expect(meta).toMatchObject({ total: 0, pageCount: 0 });
  });
});

describe("summary", () => {
  it("counts new and removed Postings against the current Job List", () => {
    const kept = listed({ company: "Kept" });
    const gone = listed({ company: "Gone" });
    const before = refresh([kept, gone]).jobList;
    const current: CurrentJobList = { meta: metaFor(2), pages: [page(1, before)] };
    const { summary } = refresh(
      [kept, listed({ company: "New 1" }), listed({ company: "New 2" })],
      {
        current,
      },
    );
    expect(summary).toMatchObject({ total: 3, newPostings: 2, removedPostings: 1 });
  });

  it("names the top Postings and Location Tier entries that matched nothing", () => {
    const { summary } = refresh([listed({ company: "Acme", companyTier: "Tier 1" }), listed()]);
    expect(summary.top[0]).toEqual({
      company: "Acme",
      title: "Software Engineer, New Grad",
      locations: ["New York, NY"],
      locationTier: 1,
      score: expect.any(Number) as number,
      applyUrl: expect.stringMatching(/^https:/) as string,
    });
    expect(summary.unmatchedLocations).toEqual(["Remote", "Boston"]);
  });
});

describe("failing Sources", () => {
  it("reports a failing Source and keeps its Postings from the last Refresh", () => {
    const before = refresh([
      listed({ company: "Acme" }),
      listed({ company: "Beta", location: "Boston, MA" }),
    ]).jobList;
    const current: CurrentJobList = {
      meta: metaFor(2, [{ name: "Job Feed", ok: true, postings: 2 }]),
      pages: [page(1, before)],
    };
    const { jobList, meta, summary } = runRefresh({
      now: NOW,
      settings,
      current,
      sources: [{ name: "Job Feed", ok: false, error: "The Job Feed answered HTTP 503." }],
    });
    expect(jobList.map((p) => p.company)).toEqual(["Acme", "Beta"]);
    expect(meta.sources).toEqual([
      { name: "Job Feed", ok: false, postings: 0, error: "The Job Feed answered HTTP 503." },
    ]);
    expect(summary).toMatchObject({ carriedOver: 2, newPostings: 0, removedPostings: 0 });
    expect(summary.sources[0]).toMatchObject({ ok: false });
  });

  it("drops kept Postings that no longer fit changed settings", () => {
    const before = refresh([
      listed({ company: "Acme" }),
      listed({ company: "Beta", location: "Boston, MA" }),
    ]).jobList;
    const current: CurrentJobList = { meta: metaFor(2), pages: [page(1, before)] };
    const nycOnly: Settings = {
      ...settings,
      searchProfile: {
        ...settings.searchProfile,
        locationTiers: [{ locations: ["New York City"] }],
      },
    };
    const { jobList } = runRefresh({
      now: NOW,
      settings: nycOnly,
      current,
      sources: [{ name: "Job Feed", ok: false, error: "timeout" }],
    });
    expect(jobList.map((p) => p.company)).toEqual(["Acme"]);
  });

  it("is deterministic: the same input gives the same change set", () => {
    const postings = Array.from({ length: 30 }, (_, i) => listed({ age: `${String(i)}d` }));
    expect(refresh(postings)).toEqual(refresh(postings));
  });
});
