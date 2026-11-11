import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryFillIo } from "../fill/testing/memory-io.ts";
import { compareVersions, runDashboard, type DashboardIo } from "./dashboard.ts";

const ROOT = "/plugins/job-app-assist";
const URL = "https://claude.ai/artifact/8tozfAJmBGb8LBfdngmDWm";
const PAGE = "<title>Job App Assist</title>\n<div id=app></div>\n";

function setup(files: Record<string, string>, version = "0.12.0") {
  const io = memoryFillIo(
    {
      [`${ROOT}/.claude-plugin/plugin.json`]: JSON.stringify({ name: "job-app-assist", version }),
      [`${ROOT}/dist/dashboard.html`]: PAGE,
      ...files,
    },
    { now: "2026-11-10T15:00:00.000Z" },
  );
  const dashboardIo: DashboardIo & typeof io = Object.assign(io, { pluginRoot: () => ROOT });
  return dashboardIo;
}

const recorded = (pageVersion?: string) =>
  JSON.stringify({ url: URL, ...(pageVersion === undefined ? {} : { pageVersion }) });

describe("compareVersions", () => {
  it("compares each part as a number", () => {
    expect(compareVersions("0.10.0", "0.9.3")).toBeGreaterThan(0);
    expect(compareVersions("0.9.3", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("jaa dashboard check", () => {
  it("copies the newer page and says to publish it in place", async () => {
    const io = setup({ ".job-app-assist/dashboard.json": recorded("0.11.0") });
    expect(await runDashboard(["check", ".job-app-assist"], io)).toBe(0);
    expect(io.disk.get(resolve(".job-app-assist/dashboard.html"))).toBe(PAGE);
    expect(io.out).toContain("newer dashboard page: 0.12.0, replacing 0.11.0");
    expect(io.out).toContain(`Publish .job-app-assist/dashboard.html to ${URL}`);
    expect(io.out).toContain("without capabilities");
    expect(io.out).toContain("jaa dashboard record .job-app-assist");
  });

  it("treats a dashboard with no recorded page version as older", async () => {
    const io = setup({ ".job-app-assist/dashboard.json": recorded() });
    expect(await runDashboard(["check", ".job-app-assist"], io)).toBe(0);
    expect(io.out).toContain("newer dashboard page: 0.12.0");
    expect(io.disk.has(resolve(".job-app-assist/dashboard.html"))).toBe(true);
  });

  it("leaves an up-to-date page alone", async () => {
    const io = setup({ ".job-app-assist/dashboard.json": recorded("0.12.0") });
    expect(await runDashboard(["check", ".job-app-assist"], io)).toBe(0);
    expect(io.out).toBe("The dashboard page is up to date (0.12.0). Nothing to publish.\n");
    expect(io.disk.has(resolve(".job-app-assist/dashboard.html"))).toBe(false);
  });

  it("never replaces a newer published page with an older one", async () => {
    const io = setup({ ".job-app-assist/dashboard.json": recorded("0.13.0") });
    expect(await runDashboard(["check", ".job-app-assist"], io)).toBe(0);
    expect(io.out).toContain("newer than this Toolkit (0.12.0)");
    expect(io.out).toContain("claude plugin update job-app-assist@job-app-assist");
    expect(io.disk.has(resolve(".job-app-assist/dashboard.html"))).toBe(false);
  });

  it("sends the Candidate to Setup when there is no dashboard yet", async () => {
    const io = setup({});
    expect(await runDashboard(["check", ".job-app-assist"], io)).toBe(1);
    expect(io.err).toContain("/job-app-assist:setup");
  });

  it("reports a dashboard file it cannot use", async () => {
    const io = setup({ ".job-app-assist/dashboard.json": '{"url": "https://example.com/x"}' });
    expect(await runDashboard(["check", ".job-app-assist"], io)).toBe(1);
    expect(io.err).toContain("claude.ai artifact link");
  });
});

describe("jaa dashboard page", () => {
  it("copies the Toolkit's page for a first publish", async () => {
    const io = setup({});
    expect(await runDashboard(["page", ".job-app-assist"], io)).toBe(0);
    expect(io.disk.get(resolve(".job-app-assist/dashboard.html"))).toBe(PAGE);
    expect(io.out).toContain("version 0.12.0");
  });
});

describe("jaa dashboard record", () => {
  it("records the dashboard link and the page version just published", async () => {
    const io = setup({});
    expect(await runDashboard(["record", ".job-app-assist", URL], io)).toBe(0);
    expect(JSON.parse(io.disk.get(resolve(".job-app-assist/dashboard.json")) ?? "")).toEqual({
      url: URL,
      pageVersion: "0.12.0",
    });
  });

  it("keeps anything else the file holds", async () => {
    const io = setup({
      ".job-app-assist/dashboard.json": JSON.stringify({ url: URL, pageVersion: "0.1.0", note: 1 }),
    });
    expect(await runDashboard(["record", ".job-app-assist", URL], io)).toBe(0);
    expect(JSON.parse(io.disk.get(resolve(".job-app-assist/dashboard.json")) ?? "")).toEqual({
      url: URL,
      pageVersion: "0.12.0",
      note: 1,
    });
  });

  it("refuses to point the Candidate folder at a different dashboard", async () => {
    const io = setup({ ".job-app-assist/dashboard.json": recorded("0.11.0") });
    const other = "https://claude.ai/artifact/otherOtherOther1";
    expect(await runDashboard(["record", ".job-app-assist", other], io)).toBe(1);
    expect(io.err).toContain(URL);
    expect(JSON.parse(io.disk.get(resolve(".job-app-assist/dashboard.json")) ?? "")).toEqual({
      url: URL,
      pageVersion: "0.11.0",
    });
  });

  it("switches dashboards only when told to", async () => {
    const io = setup({ ".job-app-assist/dashboard.json": recorded("0.11.0") });
    const other = "https://claude.ai/artifact/otherOtherOther1";
    expect(await runDashboard(["record", ".job-app-assist", other, "--replace"], io)).toBe(0);
    expect(JSON.parse(io.disk.get(resolve(".job-app-assist/dashboard.json")) ?? "")).toEqual({
      url: other,
      pageVersion: "0.12.0",
    });
  });

  it("accepts only claude.ai artifact links", async () => {
    const io = setup({});
    expect(await runDashboard(["record", ".job-app-assist", "https://example.com/a"], io)).toBe(1);
    expect(io.err).toContain("claude.ai artifact link");
  });
});
