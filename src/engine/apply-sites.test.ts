import { describe, expect, it } from "vitest";
import { applySiteOf, onBlockedSite } from "./apply-sites.ts";

describe("apply sites", () => {
  it("matches a blocked site and its subdomains only", () => {
    const sites = ["myworkdayjobs.com"];
    expect(onBlockedSite("https://myworkdayjobs.com/x", sites)).toBe(true);
    expect(onBlockedSite("https://acme.wd5.MyWorkdayJobs.com/en-US/1", sites)).toBe(true);
    expect(onBlockedSite("https://notmyworkdayjobs.com/1", sites)).toBe(false);
    expect(onBlockedSite("https://jobs.lever.co/acme/1", sites)).toBe(false);
    expect(onBlockedSite("not a url", sites)).toBe(false);
    expect(onBlockedSite("https://acme.myworkdayjobs.com/1", [])).toBe(false);
  });

  it("names the site an apply URL is on", () => {
    expect(applySiteOf("https://acme.wd5.myworkdayjobs.com/en-US/1")).toBe("myworkdayjobs.com");
    expect(applySiteOf("https://jobs.lever.co/acme/1")).toBe("lever.co");
    expect(applySiteOf("nope")).toBeUndefined();
  });
});
