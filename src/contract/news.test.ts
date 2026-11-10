import { describe, expect, it } from "vitest";
import { validateDocument } from "./index.ts";
import {
  BLOCKED_NEWS_HOSTS,
  NEWS_COLLECTION,
  blockedNewsHost,
  validateNewsDigest,
  type NewsDigest,
} from "./news.ts";
import {
  sampleCompanyNews,
  sampleDigest,
  sampleForumHighlight,
  sampleSignal,
  sampleStory,
  without,
} from "./testing/fixtures.ts";

const issuesOf = (input: unknown) => {
  const result = validateNewsDigest(input);
  return result.ok ? [] : result.issues;
};

const story = (n: number) => sampleStory(n, { url: `https://example.com/story-${String(n)}` });
const stories = (count: number) => Array.from({ length: count }, (_, i) => story(i));

describe("News Digest document", () => {
  it("accepts a full digest", () => {
    expect(validateNewsDigest(sampleDigest())).toEqual({ ok: true, value: sampleDigest() });
  });

  it("is stored under its own day, one per day", () => {
    expect(validateDocument(NEWS_COLLECTION, "2026-11-10", sampleDigest()).ok).toBe(true);
    expect(validateDocument(NEWS_COLLECTION, "2026-11-09", sampleDigest())).toEqual({
      ok: false,
      issues: ["A News Digest is stored under its day: news/2026-11-10, not news/2026-11-09."],
    });
  });

  it.each([5, 8])("accepts %i industry stories", (count) => {
    expect(issuesOf(sampleDigest({ industryNews: stories(count) }))).toEqual([]);
  });

  it.each([4, 1])("rejects %i industry stories", (count) => {
    expect(issuesOf(sampleDigest({ industryNews: stories(count) }))).toEqual([
      "industryNews: list 5 to 8 industry stories, or none with a gap that says why",
    ]);
  });

  it("rejects more than 8 industry stories", () => {
    expect(issuesOf(sampleDigest({ industryNews: stories(9) }))).toEqual([
      "industryNews: list at most 8 industry stories",
    ]);
  });

  it("accepts no industry stories only with a gap that says why", () => {
    expect(issuesOf(sampleDigest({ industryNews: [] }))).toHaveLength(1);
    expect(
      issuesOf(
        sampleDigest({
          industryNews: [],
          gaps: [{ section: "industryNews", note: "Web search was unavailable today." }],
        }),
      ),
    ).toEqual([]);
  });

  it("requires every industry story to say why it matters", () => {
    const noWhy = without(story(9), "whyItMatters");
    expect(issuesOf({ ...sampleDigest(), industryNews: [...stories(4), noWhy] })).toEqual([
      expect.stringMatching(/^industryNews\.4\.whyItMatters: /),
    ]);
  });

  it("requires every item to link its source", () => {
    const digest = sampleDigest();
    expect(issuesOf({ ...digest, companyNews: [without(sampleCompanyNews(), "url")] })).toEqual([
      expect.stringMatching(/^companyNews\.0\.url: /),
    ]);
    expect(
      issuesOf({ ...digest, companyNews: [sampleCompanyNews({ url: "acme.com/news" })] }),
    ).toEqual(["companyNews.0.url: must be an http or https web address"]);
  });

  it("links each hiring signal to its Postings' apply URLs", () => {
    const digest = sampleDigest();
    const signal = sampleSignal();
    expect(issuesOf({ ...digest, hiringSignals: [{ ...signal, postings: [] }] })).toEqual([
      "hiringSignals.0.postings: list at least one Posting",
    ]);
    expect(issuesOf({ ...digest, hiringSignals: [{ ...signal, newPostings: 0 }] })).toContain(
      "hiringSignals.0.newPostings: must be at least 1",
    );
  });

  it.each([
    ["https://www.linkedin.com/posts/someone_layoffs-123", "linkedin.com"],
    ["https://lnkd.in/abc", "lnkd.in"],
    ["https://www.teamblind.com/post/Meta-layoffs-abc", "teamblind.com"],
  ])("never links to LinkedIn or Blind: %s", (url, host) => {
    const digest = sampleDigest();
    expect(issuesOf({ ...digest, industryNews: [...stories(4), { ...story(9), url }] })).toEqual([
      `industryNews.4.url: must not link to ${host}; the digest never reads LinkedIn or Blind`,
    ]);
  });

  it("knows which hosts are blocked, subdomains included", () => {
    expect(BLOCKED_NEWS_HOSTS).toContain("teamblind.com");
    expect(blockedNewsHost("https://uk.linkedin.com/in/x")).toBe("linkedin.com");
    expect(blockedNewsHost("https://notlinkedin.com/x")).toBeUndefined();
    expect(blockedNewsHost("https://news.ycombinator.com/item?id=1")).toBeUndefined();
  });

  it("links each forum highlight to a thread on that forum", () => {
    const digest = sampleDigest();
    const highlight = sampleForumHighlight();
    const withUrl = (forum: NewsDigest["forumHighlights"][number]["forum"], url: string) =>
      issuesOf({ ...digest, forumHighlights: [{ ...highlight, forum, url }] });
    expect(
      withUrl("r/cscareerquestions", "https://old.reddit.com/r/cscareerquestions/comments/x/y/"),
    ).toEqual([]);
    expect(withUrl("r/csMajors", "https://www.reddit.com/r/cscareerquestions/comments/x/")).toEqual(
      [
        "forumHighlights.0.url: must be a r/csMajors thread, like https://www.reddit.com/r/csMajors/comments/...",
      ],
    );
    expect(withUrl("Hacker News", "https://techcrunch.com/story")).toHaveLength(1);
  });

  it("rejects a forum it does not read", () => {
    const digest = sampleDigest();
    expect(
      issuesOf({
        ...digest,
        forumHighlights: [{ ...digest.forumHighlights[0], forum: "Blind" }],
      })[0],
    ).toMatch(/^forumHighlights\.0\.forum: /);
  });

  it("rejects two items that link the same source", () => {
    const digest = sampleDigest();
    const url = sampleCompanyNews().url;
    expect(issuesOf({ ...digest, industryNews: [...stories(4), { ...story(9), url }] })).toEqual([
      "industryNews.4.url: links a source another item already links",
    ]);
  });

  it("rejects fields outside the contract", () => {
    expect(issuesOf({ ...sampleDigest(), mood: "upbeat" })).toHaveLength(1);
  });
});
