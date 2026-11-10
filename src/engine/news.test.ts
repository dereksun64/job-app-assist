import { describe, expect, it } from "vitest";
import { validateDocument, type Card, type Posting } from "../contract/index.ts";
import { sampleCompanyNews, sampleDigest } from "../contract/testing/fixtures.ts";
import { buildDigest, dayIn, planNews, staleNewsDays, type NewsPlan } from "./news.ts";

const DAY = "2026-11-10";

let counter = 0;
function posting(overrides: Partial<Posting> = {}): Posting {
  counter += 1;
  return {
    id: counter.toString(16).padStart(12, "0"),
    applyUrl: `https://jobs.lever.co/acme/${String(counter)}`,
    company: `Company ${String(counter)}`,
    title: "Software Engineer, New Grad",
    locations: ["New York, NY"],
    locationTier: 1,
    roleType: "Software Engineer",
    level: "new_grad",
    postedOn: "2026-11-08",
    sources: [{ name: "Job Feed" }],
    score: 80,
    boosts: [],
    resumeVariant: { name: "Generalist SWE", reason: "Your only Resume Variant." },
    ...overrides,
  };
}

function card(of: Posting, overrides: Partial<Card> = {}): Card {
  return {
    schemaVersion: 1,
    postingId: of.id,
    stage: "queued",
    queuedAt: "2026-11-09T15:00:00.000Z",
    queuedBy: "refresh",
    posting: of,
    updatedAt: "2026-11-09T15:00:00.000Z",
    ...overrides,
  };
}

const plan = (overrides: Partial<Parameters<typeof planNews>[0]> = {}) =>
  planNews({ day: DAY, postings: [], cards: [], recent: [], ...overrides });

describe("hiring signals", () => {
  it("names boosted companies with entry-level Postings posted this week, most first", () => {
    const postings = [
      posting({ company: "Google", boosts: ["Fortune 500"], postedOn: "2026-11-09" }),
      posting({ company: "Stripe", boosts: ["Company tier 1"], postedOn: "2026-11-10" }),
      posting({ company: "Google", boosts: ["Fortune 500"], postedOn: "2026-11-04" }),
      posting({ company: "Unboosted", boosts: [], postedOn: "2026-11-10" }),
    ];
    const { hiringSignals, newThisWeek } = plan({ postings });
    expect(newThisWeek).toBe(4);
    expect(hiringSignals.map((s) => [s.company, s.newPostings])).toEqual([
      ["Google", 2],
      ["Stripe", 1],
    ]);
  });

  it("counts only the 7 days up to the digest's day", () => {
    const postings = [
      posting({ company: "Old", boosts: ["Fortune 500"], postedOn: "2026-11-03" }),
      posting({ company: "Edge", boosts: ["Fortune 500"], postedOn: "2026-11-04" }),
    ];
    const result = plan({ postings });
    expect(result.newThisWeek).toBe(1);
    expect(result.hiringSignals.map((s) => s.company)).toEqual(["Edge"]);
  });

  it("leaves out companies boosted only by the lower Job Feed tiers", () => {
    const postings = [
      posting({ company: "Tier Three", boosts: ["Company tier 3"] }),
      posting({ company: "Tier Four", boosts: ["Company tier 4"] }),
      posting({ company: "Tier Two", boosts: ["Company tier 2"] }),
    ];
    expect(plan({ postings }).hiringSignals.map((s) => s.company)).toEqual(["Tier Two"]);
  });

  it("links each signal's newest Postings by apply URL, at most three, and counts them all", () => {
    const postings = [
      "2026-11-05",
      "2026-11-10",
      "2026-11-06",
      "2026-11-09",
      "2026-11-07",
      "2026-11-08",
    ].map((postedOn) => posting({ company: "Amazon", boosts: ["Fortune 500"], postedOn }));
    const [signal] = plan({ postings }).hiringSignals;
    expect(signal?.newPostings).toBe(6);
    expect(signal?.postings.map((p) => p.postedOn)).toEqual([
      "2026-11-10",
      "2026-11-09",
      "2026-11-08",
    ]);
    expect(signal?.postings[0]).toEqual({
      id: postings[1]?.id,
      title: "Software Engineer, New Grad",
      level: "new_grad",
      postedOn: "2026-11-10",
      applyUrl: postings[1]?.applyUrl,
    });
  });

  it("groups one company's spellings together", () => {
    const postings = [
      posting({ company: "Capital One", boosts: ["Fortune 500"] }),
      posting({ company: "Capital One, Inc.", boosts: ["Fortune 500"] }),
    ];
    expect(plan({ postings }).hiringSignals).toHaveLength(1);
  });

  it("keeps the twelve strongest signals", () => {
    const postings = Array.from({ length: 15 }, (_, i) =>
      posting({ company: `Big ${String(i)}`, boosts: ["Fortune 500"] }),
    );
    expect(plan({ postings }).hiringSignals).toHaveLength(12);
  });
});

describe("news plan", () => {
  it("lists each company in the Queue once, leaving out later Stages and unknown names", () => {
    const a = posting({ company: "Acme" });
    const b = posting({ company: "Acme Inc." });
    const c = posting({ company: "Brainy" });
    const d = posting({ company: "Unknown company" });
    const e = posting({ company: "Submitted Co" });
    const cards = [card(c), card(a), card(b), card(d), card(e, { stage: "submitted" })];
    expect(plan({ cards }).queueCompanies).toEqual(["Acme", "Brainy"]);
  });

  it("lists sources linked in the past week's digests, so stories are not repeated", () => {
    const yesterday = sampleDigest({ day: "2026-11-09" });
    const old = sampleDigest({ day: "2026-11-01" });
    const today = sampleDigest({ day: DAY });
    const { recentUrls } = plan({ recent: [yesterday, old, today] });
    expect(recentUrls).toContain(yesterday.industryNews[0]?.url);
    expect(recentUrls).toContain(yesterday.forumHighlights[0]?.url);
    expect(recentUrls).toHaveLength(
      yesterday.industryNews.length +
        yesterday.forumHighlights.length +
        yesterday.companyNews.length,
    );
  });
});

describe("building the digest", () => {
  const gathered = () => {
    const { forumHighlights, companyNews, industryNews, gaps } = sampleDigest();
    return { forumHighlights, companyNews, industryNews, gaps };
  };
  const base: NewsPlan = {
    day: DAY,
    newThisWeek: 3,
    hiringSignals: sampleDigest().hiringSignals,
    queueCompanies: ["Acme"],
    recentUrls: [],
  };
  const BUILT = "2026-11-10T15:30:00.000Z";

  it("joins the hiring signals with the news gathered in chat into one contract document", () => {
    const result = buildDigest(base, gathered(), BUILT);
    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        day: DAY,
        builtAt: BUILT,
        newThisWeek: 3,
        hiringSignals: base.hiringSignals,
        ...gathered(),
      },
    });
    if (result.ok) expect(validateDocument("news", DAY, result.value).ok).toBe(true);
  });

  it("keeps company news to companies in the Queue", () => {
    const news = gathered();
    news.companyNews = [sampleCompanyNews({ company: "Elsewhere Corp" })];
    expect(buildDigest(base, news, BUILT)).toEqual({
      ok: false,
      issues: [
        'companyNews.0.company: "Elsewhere Corp" is not in the Queue; company news covers only Acme',
      ],
    });
  });

  it("matches Queue companies however they are spelled", () => {
    const news = gathered();
    news.companyNews = [sampleCompanyNews({ company: "ACME, Inc." })];
    expect(buildDigest(base, news, BUILT).ok).toBe(true);
  });

  it("reports contract problems by their place in the gathered news", () => {
    const news = gathered();
    news.industryNews = news.industryNews.slice(0, 4);
    expect(buildDigest(base, news, BUILT)).toEqual({
      ok: false,
      issues: ["industryNews: list 5 to 8 industry stories, or none with a gap that says why"],
    });
  });

  it("rejects gathered news that is not the four news sections", () => {
    expect(buildDigest(base, { ...gathered(), day: "2026-01-01" }, BUILT)).toEqual({
      ok: false,
      issues: [
        "day: is not a news section; write only forumHighlights, companyNews, industryNews and gaps",
      ],
    });
    expect(buildDigest(base, [], BUILT)).toEqual({
      ok: false,
      issues: [
        "The gathered news must be an object with forumHighlights, companyNews, industryNews and gaps.",
      ],
    });
  });

  it("treats a missing section as empty", () => {
    const { industryNews } = gathered();
    const result = buildDigest(base, { industryNews }, BUILT);
    expect(result.ok && result.value.forumHighlights).toEqual([]);
  });
});

describe("days", () => {
  it("names the Candidate's own day, not the UTC one", () => {
    expect(dayIn("2026-11-11T03:00:00.000Z", "America/Los_Angeles")).toBe("2026-11-10");
    expect(dayIn("2026-11-11T03:00:00.000Z", "UTC")).toBe("2026-11-11");
  });

  it("drops digests older than 90 days", () => {
    expect(staleNewsDays(["2026-08-12", "2026-08-13", "2026-11-09", "not-a-day"], DAY)).toEqual([
      "2026-08-12",
    ]);
  });
});
