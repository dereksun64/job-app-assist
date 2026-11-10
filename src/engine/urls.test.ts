import { describe, expect, it } from "vitest";
import { canonicalApplyUrl, isShortLink, postingId } from "./urls.ts";

describe("canonicalApplyUrl", () => {
  it.each([
    [
      "https://jobs.lever.co/matillion/72564dd8/apply?utm_source=Simplify&ref=Simplify",
      "https://jobs.lever.co/matillion/72564dd8",
    ],
    [
      "https://boards.greenhouse.io/acme/jobs/123?gh_src=abc",
      "https://job-boards.greenhouse.io/acme/jobs/123",
    ],
    [
      "https://job-boards.greenhouse.io/acme/jobs/123/",
      "https://job-boards.greenhouse.io/acme/jobs/123",
    ],
    ["https://jobs.ashbyhq.com/acme/0d9a/application?src=x", "https://jobs.ashbyhq.com/acme/0d9a"],
    [
      "http://WWW.Amazon.jobs/en/jobs/2891234/sde-intern",
      "https://amazon.jobs/en/jobs/2891234/sde-intern",
    ],
    [
      "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1?source=LinkedIn#apply",
      "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1",
    ],
  ])("reduces %s to %s", (url, canonical) => {
    expect(canonicalApplyUrl(url)).toBe(canonical);
  });

  it("keeps query parameters that identify the job, in a stable order", () => {
    expect(canonicalApplyUrl("https://careers.acme.com/apply?job=9&utm_medium=x&lang=en")).toBe(
      "https://careers.acme.com/apply?job=9&lang=en",
    );
    expect(canonicalApplyUrl("https://careers.acme.com/apply?lang=en&gh_jid=9")).toBe(
      "https://careers.acme.com/apply?gh_jid=9&lang=en",
    );
  });

  it("leaves text that is not a web address as it is", () => {
    expect(canonicalApplyUrl("not a url")).toBe("not a url");
  });
});

describe("short links", () => {
  it("recognizes the Job Feed's short links", () => {
    expect(isShortLink("https://go.vansh.nyc/1rE?s=A")).toBe(true);
    expect(isShortLink("https://job-boards.greenhouse.io/acme/jobs/1")).toBe(false);
    expect(isShortLink("garbage")).toBe(false);
  });
});

describe("postingId", () => {
  it("is a stable 12-character hash of the canonical apply URL", () => {
    const id = postingId("https://jobs.lever.co/acme/1");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(postingId("https://jobs.lever.co/acme/1")).toBe(id);
    expect(postingId("https://jobs.lever.co/acme/2")).not.toBe(id);
  });
});
