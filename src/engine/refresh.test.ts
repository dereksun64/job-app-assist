import { describe, expect, it } from "vitest";
import {
  MAX_JOB_LIST,
  POSTINGS_PER_PAGE,
  validateDocument,
  type JobListMeta,
  type JobListPage,
  type AddedPosting,
  type Posting,
  type Settings,
  type SourceSettings,
  type WatchedCompany,
} from "../contract/index.ts";
import {
  MAX_VARIANT_REVIEW,
  runRefresh,
  shortLinksToResolve,
  type CurrentJobList,
  type RefreshInput,
} from "./refresh.ts";
import { EMPTY_QUEUE } from "./queue.ts";
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
  resumeVariants: [
    { name: "Generalist SWE", roleTypes: ["Software Engineer"], keywords: ["full stack"] },
    {
      name: "Backend SWE/SDE",
      roleTypes: ["Software Engineer"],
      keywords: ["backend", "distributed systems", "infrastructure", "API"],
    },
    {
      name: "AI/ML Engineer",
      roleTypes: ["Machine Learning Engineer"],
      keywords: ["machine learning", "ML", "AI", "LLM"],
    },
  ],
  dailyQueueTarget: 20,
  companies: { boost: [], lower: [], block: [] },
  blockedApplySites: [],
  freshnessWeight: 20,
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
    queue: EMPTY_QUEUE,
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
    expect(summary.filteredOut).toEqual({
      location: 1,
      seniority: 1,
      startWindow: 1,
      roleType: 1,
      company: 0,
      applySite: 0,
    });
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

describe("the Candidate's ranking settings", () => {
  const tuned = (overrides: Partial<Settings>): Settings => ({ ...settings, ...overrides });
  const rules = (overrides: Partial<Settings["companies"]>): Settings["companies"] => ({
    boost: [],
    lower: [],
    block: [],
    ...overrides,
  });

  it("ranks a boosted company with the top company tiers and says why", () => {
    const postings = [
      listed({ company: "OpenAI", companyTier: "Tier 1" }),
      listed({ company: "Tiny AI Startup, Inc." }),
    ];
    const { jobList } = refresh(postings, {
      settings: tuned({ companies: rules({ boost: ["tiny ai startup"] }) }),
    });
    expect(jobList.map((p) => [p.company, p.score])).toEqual([
      ["OpenAI", jobList[0]?.score],
      ["Tiny AI Startup, Inc.", jobList[0]?.score],
    ]);
    expect(jobList.find((p) => p.company.startsWith("Tiny"))?.boosts).toEqual(["Boosted by you"]);
  });

  it("ranks a lowered company below companies with no rule, never under 0", () => {
    const { jobList } = refresh(
      [
        listed({ company: "Lockheed Martin", age: "0d" }),
        listed({ company: "Plain", age: "2mo" }),
        listed({ company: "Northrop Grumman", title: "Associate Product Manager", age: "1y" }),
      ],
      {
        settings: tuned({ companies: rules({ lower: ["Lockheed Martin", "Northrop Grumman"] }) }),
      },
    );
    expect(jobList.map((p) => p.company)).toEqual(["Plain", "Lockheed Martin", "Northrop Grumman"]);
    expect(jobList[1]?.boosts).toEqual(["Lowered by you"]);
    expect(jobList[2]?.score).toBe(0);
  });

  it("leaves blocked companies out of the Job List and counts them", () => {
    const { jobList, summary } = refresh(
      [listed({ company: "Acme" }), listed({ company: "Palantir Technologies Inc." })],
      { settings: tuned({ companies: rules({ block: ["palantir technologies"] }) }) },
    );
    expect(jobList.map((p) => p.company)).toEqual(["Acme"]);
    expect(summary.filteredOut).toMatchObject({ company: 1, applySite: 0 });
  });

  it("leaves out Postings that only apply on a blocked site, keeping another site's twin", () => {
    const { jobList, summary } = refresh(
      [
        listed({ company: "Only Workday", applyUrl: "https://acme.wd5.myworkdayjobs.com/en/1" }),
        listed({ company: "Twin", applyUrl: "https://twin.wd1.myworkdayjobs.com/jobs/2" }),
        listed({ company: "Twin", applyUrl: "https://jobs.lever.co/twin/2" }),
        listed({ company: "Lookalike", applyUrl: "https://notmyworkdayjobs.com/3" }),
      ],
      { settings: tuned({ blockedApplySites: ["myworkdayjobs.com"] }) },
    );
    expect(jobList.map((p) => [p.company, p.applyUrl])).toEqual([
      ["Lookalike", "https://notmyworkdayjobs.com/3"],
      ["Twin", "https://jobs.lever.co/twin/2"],
    ]);
    expect(summary.filteredOut).toMatchObject({ applySite: 1 });
  });

  it("weighs freshness by the freshness weight", () => {
    const postings = [
      listed({ company: "Old Star", companyTier: "Tier 1", age: "30d" }),
      listed({ company: "New Plain", age: "0d" }),
    ];
    const order = (freshnessWeight: number) =>
      refresh(postings, { settings: tuned({ freshnessWeight }) }).jobList.map((p) => p.company);
    expect(order(20)).toEqual(["Old Star", "New Plain"]);
    expect(order(50)).toEqual(["New Plain", "Old Star"]);
    expect(refresh(postings, { settings: tuned({ freshnessWeight: 0 }) }).jobList[1]?.score).toBe(
      63,
    );
  });

  it("applies the rules to Postings kept from a failing Source", () => {
    const before = refresh([
      listed({ company: "Acme" }),
      listed({ company: "Beta" }),
      listed({ company: "Gamma", applyUrl: "https://gamma.icims.com/jobs/1" }),
    ]).jobList;
    const { jobList } = runRefresh({
      now: NOW,
      settings: tuned({
        companies: rules({ boost: ["Beta"], block: ["Acme"] }),
        blockedApplySites: ["icims.com"],
      }),
      current: { meta: metaFor(3), pages: [page(1, before)] },
      queue: EMPTY_QUEUE,
      sources: [{ name: "Job Feed", ok: false, error: "timeout" }],
    });
    expect(jobList.map((p) => [p.company, p.boosts])).toEqual([["Beta", ["Boosted by you"]]]);
  });
});

describe("change set", () => {
  it("writes the Job List as rank-ordered pages and a meta document, all valid", () => {
    const postings = Array.from({ length: POSTINGS_PER_PAGE + 3 }, () => listed());
    const { changeSet, jobList } = refresh(postings);
    const jobListWrites = changeSet.set.filter((w) => w.collection === "postings");
    expect(jobListWrites.map((w) => `${w.collection}/${w.docId}`)).toEqual([
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
    const [first, second, meta] = jobListWrites.map((w) => w.data);
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
    const { changeSet, jobList } = refresh([listed()], { current });
    expect(changeSet.set.map((w) => w.docId)).toEqual(["page-1", "meta", jobList[0]?.id]);
    expect(changeSet.delete).toEqual([
      { collection: "postings", docId: "page-2" },
      { collection: "postings", docId: "page-3" },
    ]);
  });

  it("pre-queues the best Postings after the Job List, as cards up to the daily target", () => {
    const postings = Array.from({ length: 30 }, (_, i) =>
      listed({ location: i % 2 === 0 ? "Boston, MA" : "New York, NY" }),
    );
    const { changeSet, jobList, preQueued, summary } = refresh(postings, {
      settings: { ...settings, dailyQueueTarget: 18 },
    });
    const cardWrites = changeSet.set.slice(-18);
    expect(changeSet.set.at(-19)?.docId).toBe("meta");
    expect(cardWrites.map((w) => `${w.collection}/${w.docId}`)).toEqual(
      jobList.slice(0, 18).map((p) => `cards/${p.id}`),
    );
    expect(cardWrites.map((w) => w.data)).toEqual(preQueued);
    // The 15 New York Postings are Tier 1, so Boston (Tier 2) fills only the last 3 slots.
    expect(preQueued.map((c) => c.posting.locationTier)).toEqual([
      ...Array<number>(15).fill(1),
      2,
      2,
      2,
    ]);
    expect(summary.queue).toEqual({
      target: 18,
      size: 18,
      preQueued: 18,
      carriedOver: 0,
      possiblyClosed: 0,
      notListed: 0,
    });
  });

  it("never pre-queues a skipped Posting or writes over an existing card", () => {
    const postings = [listed(), listed(), listed()];
    const [first, second, third] = refresh(postings).jobList.map((p) => p.id);
    const { preQueued, summary } = refresh(postings, {
      settings: { ...settings, dailyQueueTarget: 3 },
      queue: { cards: [], cardIds: [first ?? ""], skippedIds: [second ?? ""] },
    });
    expect(preQueued.map((c) => c.postingId)).toEqual([third]);
    expect(summary.queue).toMatchObject({ preQueued: 1, size: 1 });
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
      queue: EMPTY_QUEUE,
      sources: [{ name: "Job Feed", ok: false, error: "The Job Feed answered HTTP 503." }],
    });
    expect(jobList.map((p) => p.company)).toEqual(["Acme", "Beta"]);
    expect(meta.sources).toEqual([
      { name: "Job Feed", ok: false, postings: 0, error: "The Job Feed answered HTTP 503." },
    ]);
    expect(summary).toMatchObject({
      carriedOver: 2,
      newPostings: 0,
      removedPostings: 0,
      unmatchedLocations: [],
    });
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
      queue: EMPTY_QUEUE,
      sources: [{ name: "Job Feed", ok: false, error: "timeout" }],
    });
    expect(jobList.map((p) => p.company)).toEqual(["Acme"]);
  });

  it("is deterministic: the same input gives the same change set", () => {
    const postings = Array.from({ length: 30 }, (_, i) => listed({ age: `${String(i)}d` }));
    expect(refresh(postings)).toEqual(refresh(postings));
  });
});

describe("Resume Variants", () => {
  it("picks a Resume Variant for every Posting and records why", () => {
    const { jobList } = refresh([
      listed({ company: "Acme", title: "Backend Engineer, New Grad" }),
      listed({
        company: "Brainy",
        title: "Machine Learning Engineer Intern",
        jobType: "internship",
      }),
      listed({ company: "Plain", title: "Software Engineer, New Grad" }),
    ]);
    const picks = Object.fromEntries(jobList.map((p) => [p.company, p.resumeVariant]));
    expect(picks).toEqual({
      Acme: {
        name: "Backend SWE/SDE",
        reason: 'The title mentions "backend"; made for Software Engineer roles.',
      },
      Brainy: {
        name: "AI/ML Engineer",
        reason: 'The title mentions "machine learning"; made for Machine Learning Engineer roles.',
      },
      Plain: {
        name: "Generalist SWE",
        reason:
          "Made for Software Engineer roles, which fits Generalist SWE and Backend SWE/SDE equally; Generalist SWE is your default.",
      },
    });
  });

  it("reads the description a Source gives and keeps a short excerpt of it", () => {
    const description = `Join the team that runs our distributed systems and public API. ${"Lorem ipsum dolor sit amet. ".repeat(30)}`;
    const { jobList } = refresh([
      listed({ company: "Acme", title: "Software Engineer", description }),
      listed({ company: "Bare", title: "Software Engineer" }),
    ]);
    const acme = jobList.find((p) => p.company === "Acme");
    expect(acme?.resumeVariant.name).toBe("Backend SWE/SDE");
    expect(acme?.description?.length).toBeLessThanOrEqual(400);
    expect(acme?.description).toMatch(/^Join the team that runs our distributed systems.*…$/s);
    expect(acme?.description).not.toMatch(/\s…$/);
    expect(jobList.find((p) => p.company === "Bare")).not.toHaveProperty("description");
  });

  it("keeps a short description whole, with its whitespace tidied", () => {
    const { jobList } = refresh([
      listed({ description: "  Build   the payments API.\n\nWork in Go.  " }),
    ]);
    expect(jobList[0]?.description).toBe("Build the payments API. Work in Go.");
  });

  it("lists unsure picks for the Refresh skill to review, best-ranked first", () => {
    const { summary } = refresh([
      listed({ company: "Pm", title: "Product Manager, New Grad" }),
      listed({ company: "Close", title: "ML Engineer, Distributed Systems Infrastructure" }),
      listed({ company: "Sure", title: "Backend Engineer" }),
    ]);
    expect(summary.variantReview).toEqual({
      unsure: 2,
      postings: [
        expect.objectContaining({ company: "Close", picked: "Backend SWE/SDE" }),
        {
          id: expect.stringMatching(/^[0-9a-f]{12}$/) as string,
          company: "Pm",
          title: "Product Manager, New Grad",
          roleType: "Product Manager",
          picked: "Generalist SWE",
          reason: "Nothing in the title or listing points to a variant, so it uses your default.",
          applyUrl: expect.stringMatching(/^https:/) as string,
        },
      ],
    });
  });

  it("caps the review list and counts the rest", () => {
    const postings = Array.from({ length: MAX_VARIANT_REVIEW + 5 }, () =>
      listed({ title: "Product Manager, New Grad" }),
    );
    const { summary } = refresh(postings);
    expect(summary.variantReview.unsure).toBe(MAX_VARIANT_REVIEW + 5);
    expect(summary.variantReview.postings).toHaveLength(MAX_VARIANT_REVIEW);
  });

  it("applies the Refresh skill's judgments and stops asking about them", () => {
    const pm = listed({ company: "Pm", title: "Product Manager, New Grad" });
    const first = refresh([pm]);
    const id = first.jobList[0]?.id ?? "";
    const { jobList, summary } = refresh([pm], {
      variantJudgments: {
        [id]: { variant: "Backend SWE/SDE", reason: "The team builds the payments API." },
      },
    });
    expect(jobList[0]?.resumeVariant).toEqual({
      name: "Backend SWE/SDE",
      reason: "Reviewed: the team builds the payments API.",
    });
    expect(summary.variantReview).toEqual({ unsure: 0, postings: [] });
  });

  it("says Reviewed once even when the judgment already says it", () => {
    const pm = listed({ company: "Pm", title: "Product Manager, New Grad" });
    const id = refresh([pm]).jobList[0]?.id ?? "";
    const { jobList } = refresh([pm], {
      variantJudgments: {
        [id]: { variant: "Backend SWE/SDE", reason: "Reviewed: AI platform work." },
      },
    });
    expect(jobList[0]?.resumeVariant.reason).toBe("Reviewed: AI platform work.");
  });

  it("ignores a judgment for a Resume Variant the Candidate no longer has", () => {
    const pm = listed({ company: "Pm", title: "Product Manager, New Grad" });
    const id = refresh([pm]).jobList[0]?.id ?? "";
    const { jobList, summary } = refresh([pm], {
      variantJudgments: { [id]: { variant: "Retired variant", reason: "Old call." } },
    });
    expect(jobList[0]?.resumeVariant.name).toBe("Generalist SWE");
    expect(summary.variantReview.unsure).toBe(1);
  });

  it("counts picks per Resume Variant", () => {
    const { summary } = refresh([
      listed({ title: "Backend Engineer" }),
      listed({ title: "Backend Engineer, Payments" }),
      listed({ title: "Software Engineer" }),
    ]);
    expect(summary.byVariant).toEqual({
      "Generalist SWE": 1,
      "Backend SWE/SDE": 2,
      "AI/ML Engineer": 0,
    });
  });

  it("picks again for Postings kept from a failing Source, with the current variants", () => {
    const before = refresh([listed({ company: "Acme", title: "Backend Engineer" })]).jobList;
    const current: CurrentJobList = { meta: metaFor(1), pages: [page(1, before)] };
    const renamed: Settings = {
      ...settings,
      resumeVariants: [{ name: "Only resume", roleTypes: [], keywords: [] }],
    };
    const { jobList } = runRefresh({
      now: NOW,
      settings: renamed,
      current,
      queue: EMPTY_QUEUE,
      sources: [{ name: "Job Feed", ok: false, error: "timeout" }],
    });
    expect(jobList[0]?.resumeVariant).toEqual({
      name: "Only resume",
      reason: "Your only Resume Variant.",
    });
  });
});

describe("Sources", () => {
  const stripe: WatchedCompany = { name: "Stripe", board: "greenhouse", slug: "stripe" };
  const ramp: WatchedCompany = { name: "Ramp", board: "ashby", slug: "ramp" };

  function sourceSettings(overrides: Partial<SourceSettings> = {}): SourceSettings {
    return {
      jobFeed: { enabled: true },
      watchlist: { enabled: true, companies: [stripe, ramp] },
      addedByUrl: { enabled: true, postings: [] },
      ...overrides,
    };
  }

  function board(
    company: WatchedCompany,
    postings: SourcePosting[],
    { listsEveryLevel = false } = {},
  ): SourceResult {
    return {
      name: "Watchlist",
      list: company.name,
      ok: true,
      listsEveryLevel,
      fetchedAt: NOW,
      postings: postings.map((p) => ({ ...p, company: company.name, list: company.name })),
    };
  }

  function addedPosting(overrides: Partial<AddedPosting> = {}): AddedPosting {
    return {
      url: "https://runway.example.com/jobs/42",
      company: "Tiny Startup",
      title: "Software Engineer",
      location: "New York, NY",
      addedAt: "2026-11-07T09:30:00.000Z",
      ...overrides,
    };
  }

  it("reads only the Sources that are switched on", () => {
    const sources = [
      feed([listed({ company: "From the feed" })]),
      board(stripe, [listed({ title: "Software Engineer, New Grad" })]),
    ];
    const feedOff = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources,
      sourceSettings: sourceSettings({ jobFeed: { enabled: false } }),
    });
    expect(feedOff.jobList.map((p) => p.company)).toEqual(["Stripe"]);
    expect(feedOff.meta.sources).toEqual([
      { name: "Watchlist", list: "Stripe", ok: true, postings: 1 },
    ]);

    const watchlistOff = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources,
      sourceSettings: sourceSettings({ watchlist: { enabled: false, companies: [stripe] } }),
    });
    expect(watchlistOff.jobList.map((p) => p.company)).toEqual(["From the feed"]);
    expect(watchlistOff.meta.sources.map((s) => s.name)).toEqual(["Job Feed"]);
  });

  it("keeps only watchlist jobs whose title or job type says they are entry level", () => {
    const stripeBoard = board(
      stripe,
      [
        listed({ title: "Software Engineer, Payments", jobType: "" }),
        listed({ title: "Software Engineer, New Grad", jobType: "" }),
        listed({ title: "Software Engineer, Data Connectors", jobType: "Internship" }),
      ],
      { listsEveryLevel: true },
    );
    const { jobList, summary } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [stripeBoard],
      sourceSettings: sourceSettings(),
    });
    expect(jobList.map((p) => [p.title, p.level]).sort()).toEqual([
      ["Software Engineer, Data Connectors", "intern"],
      ["Software Engineer, New Grad", "new_grad"],
    ]);
    expect(summary.filteredOut.seniority).toBe(1);
  });

  it("ignores job boards of companies no longer on the watchlist", () => {
    const { jobList } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [board(stripe, [listed()]), board(ramp, [listed()])],
      sourceSettings: sourceSettings({ watchlist: { enabled: true, companies: [ramp] } }),
    });
    expect(jobList.map((p) => p.company)).toEqual(["Ramp"]);
  });

  it("lists watchlist Postings under the Watchlist Source, by company", () => {
    const { jobList } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [
        board(stripe, [
          listed({
            applyUrl: "https://stripe.com/jobs/search?gh_jid=8172487",
            title: "Software Engineer, New Grad",
            location: "New York, NY; Dublin",
            postedAt: "2026-11-03T13:30:34-04:00",
            age: "",
          }),
        ]),
      ],
      sourceSettings: sourceSettings(),
    });
    expect(jobList).toEqual([
      expect.objectContaining({
        company: "Stripe",
        applyUrl: "https://stripe.com/jobs/search?gh_jid=8172487",
        postedOn: "2026-11-03",
        sources: [{ name: "Watchlist", list: "Stripe" }],
      }),
    ]);
  });

  it("turns each Posting added by URL into a Posting on the next Refresh", () => {
    const { jobList, meta } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [],
      sourceSettings: sourceSettings({
        jobFeed: { enabled: false },
        watchlist: { enabled: true, companies: [] },
        addedByUrl: {
          enabled: true,
          postings: [addedPosting({ url: "https://runway.example.com/jobs/42?utm_source=x" })],
        },
      }),
    });
    expect(jobList).toEqual([
      expect.objectContaining({
        applyUrl: "https://runway.example.com/jobs/42",
        company: "Tiny Startup",
        title: "Software Engineer",
        locations: ["New York, NY"],
        locationTier: 1,
        level: "new_grad",
        postedOn: "2026-11-07",
        sources: [{ name: "Added by URL" }],
      }),
    ]);
    expect(meta.sources).toEqual([{ name: "Added by URL", ok: true, postings: 1 }]);
  });

  it("names added Postings that do not match the Search Profile, and why", () => {
    const { jobList, summary } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [],
      sourceSettings: sourceSettings({
        jobFeed: { enabled: false },
        addedByUrl: {
          enabled: true,
          postings: [
            addedPosting({ url: "https://a.example.com/1", location: "Denver, CO" }),
            addedPosting({ url: "https://a.example.com/2", title: "Staff Software Engineer" }),
            addedPosting({ url: "https://a.example.com/3" }),
          ],
        },
      }),
    });
    expect(jobList.map((p) => p.applyUrl)).toEqual(["https://a.example.com/3"]);
    expect(summary.addedLeftOut).toEqual([
      {
        url: "https://a.example.com/1",
        company: "Tiny Startup",
        title: "Software Engineer",
        reason: "location",
      },
      {
        url: "https://a.example.com/2",
        company: "Tiny Startup",
        title: "Staff Software Engineer",
        reason: "seniority",
      },
    ]);
  });

  it("names added Postings left out by a company or apply site block", () => {
    const { jobList, summary } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings: {
        ...settings,
        companies: { boost: [], lower: [], block: ["Blocked Co"] },
        blockedApplySites: ["myworkdayjobs.com"],
      },
      current: empty,
      sources: [],
      sourceSettings: sourceSettings({
        jobFeed: { enabled: false },
        addedByUrl: {
          enabled: true,
          postings: [
            addedPosting({ url: "https://a.example.com/1", company: "Blocked Co" }),
            addedPosting({ url: "https://acme.wd1.myworkdayjobs.com/2", company: "Acme" }),
          ],
        },
      }),
    });
    expect(jobList).toEqual([]);
    expect(summary.addedLeftOut.map((p) => [p.company, p.reason])).toEqual([
      ["Blocked Co", "company"],
      ["Acme", "applySite"],
    ]);
  });

  it("leaves added Postings out while Add by URL is switched off", () => {
    const { jobList, meta } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [feed([listed({ company: "Feed" })])],
      sourceSettings: sourceSettings({
        addedByUrl: { enabled: false, postings: [addedPosting()] },
      }),
    });
    expect(jobList.map((p) => p.company)).toEqual(["Feed"]);
    expect(meta.sources.map((s) => s.name)).toEqual(["Job Feed"]);
  });

  it("merges one job found in several Sources into one Posting", () => {
    const url = "https://job-boards.greenhouse.io/stripe/jobs/8172487";
    const { jobList } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [
        feed([listed({ company: "Stripe", applyUrl: `${url}?utm_source=Simplify&ref=Simplify` })]),
        board(stripe, [listed({ applyUrl: url })]),
        // The same job on the company's own career site: same company, title and place.
        board(stripe, [listed({ applyUrl: "https://stripe.com/jobs/search?gh_jid=8172487" })]),
      ],
      sourceSettings: sourceSettings({
        addedByUrl: {
          enabled: true,
          postings: [
            addedPosting({
              url: `https://boards.greenhouse.io/stripe/jobs/8172487/`,
              company: "Stripe",
              title: "Software Engineer, New Grad",
            }),
          ],
        },
      }),
    });
    expect(jobList).toHaveLength(1);
    expect(jobList[0]).toMatchObject({
      applyUrl: url,
      company: "Stripe",
      sources: [
        { name: "Added by URL" },
        { name: "Job Feed", list: "Simplify New Grad" },
        { name: "Watchlist", list: "Stripe" },
      ],
    });
  });

  it("keeps a failing watchlist company's Postings from the last Refresh, and only those", () => {
    const sourcesNow = sourceSettings({ jobFeed: { enabled: false } });
    const before = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current: empty,
      sources: [
        board(stripe, [listed({ title: "Software Engineer, New Grad" })]),
        board(ramp, [listed({ title: "Software Engineer, New Grad" })]),
      ],
      sourceSettings: sourcesNow,
    }).jobList;
    const current: CurrentJobList = { meta: metaFor(2), pages: [page(1, before)] };
    const { jobList, meta, summary } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current,
      sources: [
        {
          name: "Watchlist",
          list: "Stripe",
          ok: false,
          error: "Stripe's job board answered HTTP 503.",
        },
        board(ramp, []),
      ],
      sourceSettings: sourcesNow,
    });
    expect(jobList.map((p) => p.company)).toEqual(["Stripe"]);
    expect(summary.carriedOver).toBe(1);
    expect(meta.sources).toEqual([
      {
        name: "Watchlist",
        list: "Stripe",
        ok: false,
        postings: 0,
        error: "Stripe's job board answered HTTP 503.",
      },
      { name: "Watchlist", list: "Ramp", ok: true, postings: 0 },
    ]);
    expect(validateDocument("postings", "meta", meta)).toMatchObject({ ok: true });
  });

  it("does not keep Postings from a Source that was switched off", () => {
    const before = refresh([listed({ company: "Acme" })]).jobList;
    const current: CurrentJobList = { meta: metaFor(1), pages: [page(1, before)] };
    const { jobList } = runRefresh({
      now: NOW,
      queue: EMPTY_QUEUE,
      settings,
      current,
      sources: [],
      sourceSettings: sourceSettings({ jobFeed: { enabled: false } }),
    });
    expect(jobList).toEqual([]);
  });
});
