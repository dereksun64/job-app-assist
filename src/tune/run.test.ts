import { describe, expect, it } from "vitest";
import type { JobListMeta, JobListPage, Posting, Settings, Skip } from "../contract/index.ts";
import { runCli, type CliIo } from "../cli/jaa.ts";

const NOW = "2026-11-10T15:00:00.000Z";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Data Scientist", priority: "medium" },
    ],
    seniority: ["new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City"] }],
  },
  resumeVariants: [{ name: "Generalist SWE", roleTypes: [], keywords: [] }],
  dailyQueueTarget: 20,
  companies: { boost: ["OpenAI"], lower: [], block: [] },
  blockedApplySites: [],
  freshnessWeight: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

let next = 0;
function posting(overrides: Partial<Posting> = {}): Posting {
  next += 1;
  return {
    id: next.toString(16).padStart(12, "0"),
    applyUrl: `https://jobs.lever.co/acme/${String(next)}`,
    company: "Acme",
    title: "Software Engineer, New Grad",
    locations: ["New York, NY"],
    locationTier: 1,
    roleType: "Software Engineer",
    level: "new_grad",
    postedOn: "2026-11-01",
    sources: [{ name: "Job Feed" }],
    score: 70,
    boosts: [],
    resumeVariant: { name: "Generalist SWE", reason: "The default Resume Variant." },
    ...overrides,
  };
}

function skip(of: Posting, reason: Skip["reason"], skippedAt = "2026-11-05T00:00:00.000Z"): Skip {
  return { schemaVersion: 1, postingId: of.id, reason, skippedAt, posting: of };
}

function cli(files: Record<string, unknown>, stdin = "") {
  const disk = new Map(
    Object.entries(files).map(([path, body]) => [
      path,
      typeof body === "string" ? body : JSON.stringify(body),
    ]),
  );
  const io: CliIo & { out: string; err: string; written: string[] } = {
    out: "",
    err: "",
    written: [],
    readFile: (path) => {
      const text = disk.get(path);
      return text === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(text);
    },
    writeFile: (path) => {
      io.written.push(path);
      return Promise.resolve();
    },
    readDir: (path) =>
      Promise.resolve(
        [...disk.keys()]
          .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
          .map((p) => p.slice(path.length + 1)),
      ),
    makeDir: () => Promise.resolve(),
    removeDir: () => Promise.resolve(),
    env: () => undefined,
    homeDir: () => "/home/candidate",
    fileSize: () => Promise.resolve(undefined),
    fetch: () => Promise.reject(new Error("no network in tests")),
    now: () => NOW,
    timeZone: () => "UTC",
    sleep: () => Promise.resolve(),
    readStdin: () => Promise.resolve(stdin),
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
  };
  return io;
}

const dir = "tune";

describe("jaa tune-report", () => {
  it("reports skip patterns, their suggestions and the Job List's companies", async () => {
    const raytheon = [posting({ company: "Raytheon" }), posting({ company: "Raytheon" })];
    const listed = [
      posting({ company: "OpenAI" }),
      posting({ company: "OpenAI" }),
      posting({ company: "Lockheed Martin", applyUrl: "https://lm.wd1.myworkdayjobs.com/1" }),
    ];
    const meta: JobListMeta = {
      schemaVersion: 1,
      refreshedAt: NOW,
      pageCount: 1,
      total: 3,
      matched: 3,
      sources: [{ name: "Job Feed", ok: true, postings: 3 }],
    };
    const page: JobListPage = { schemaVersion: 1, refreshedAt: NOW, page: 1, postings: listed };
    const io = cli({
      [`${dir}/state/settings/main.json`]: settings,
      [`${dir}/state/skips/${raytheon[0]?.id ?? ""}.json`]: skip(
        raytheon[0] as Posting,
        "wrong_company",
      ),
      [`${dir}/state/skips/${raytheon[1]?.id ?? ""}.json`]: skip(
        raytheon[1] as Posting,
        "wrong_company",
      ),
      [`${dir}/state/skips/broken.json`]: "{",
      [`${dir}/state/postings/meta.json`]: meta,
      [`${dir}/state/postings/page-1.json`]: page,
    });
    expect(await runCli(["tune-report", dir], io)).toBe(0);
    expect(io.err).toBe("");
    expect(io.out).toContain("Settings now: daily Queue target 20; freshness weight 20%;");
    expect(io.out).toContain("Skips: 2 skips in the last 90 days (wrong company 2).");
    expect(io.out).toContain("- Block Raytheon: skipped 2 times as the wrong company.");
    expect(io.out).toContain("- Raytheon: 2 (wrong company 2)");
    expect(io.out).toContain(
      "Job List companies (3 Postings at 2 companies, most Postings first):\nOpenAI 2 (boosted); Lockheed Martin 1",
    );
    expect(io.out).toContain("Job List apply sites:\nlever.co 2; myworkdayjobs.com 1");
    expect(io.written).toEqual([]);
  });

  it("ignores skips older than the window", async () => {
    const old = posting({ company: "Raytheon" });
    const io = cli({
      [`${dir}/state/settings/main.json`]: settings,
      [`${dir}/state/skips/${old.id}.json`]: skip(old, "wrong_company", "2026-01-01T00:00:00.000Z"),
    });
    expect(await runCli(["tune-report", dir], io)).toBe(0);
    expect(io.out).toContain("Skips: none in the last 90 days.");
    expect(io.out).toContain("Job List: empty");
  });

  it("asks for the settings document when it is missing or invalid", async () => {
    const missing = cli({});
    expect(await runCli(["tune-report", dir], missing)).toBe(1);
    expect(missing.err).toContain("Could not read tune/state/settings/main.json.");
    const invalid = cli({ [`${dir}/state/settings/main.json`]: { schemaVersion: 1 } });
    expect(await runCli(["tune-report", dir], invalid)).toBe(1);
    expect(invalid.err).toContain(
      "The saved settings document does not match the dashboard contract:",
    );
  });
});

describe("jaa settings-diff", () => {
  const proposed: Settings = {
    ...settings,
    searchProfile: {
      ...settings.searchProfile,
      roleTypes: [
        ...settings.searchProfile.roleTypes,
        { name: "Product Manager (rotational program)", priority: "low" },
      ],
    },
    companies: { boost: ["OpenAI", "Anthropic"], lower: [], block: ["Lockheed Martin"] },
    blockedApplySites: ["myworkdayjobs.com"],
  };

  it("prints every change, reading the proposal from stdin, and writes nothing", async () => {
    const io = cli({ "current.json": settings }, JSON.stringify(proposed));
    expect(await runCli(["settings-diff", "current.json", "-"], io)).toBe(0);
    expect(io.out).toBe(
      [
        "4 changes to your settings:",
        "- Role types: added Product Manager (rotational program) at low priority",
        "- Companies: boost Anthropic",
        "- Companies: block Lockheed Martin",
        "- Blocked apply sites: added myworkdayjobs.com",
        "",
      ].join("\n"),
    );
    expect(io.written).toEqual([]);
  });

  it("says when nothing would change", async () => {
    const io = cli({ "current.json": settings, "proposed.json": settings });
    expect(await runCli(["settings-diff", "current.json", "proposed.json"], io)).toBe(0);
    expect(io.out).toBe("No changes: the proposed settings match the current ones.\n");
  });

  it("refuses a proposal outside the contract and lists why", async () => {
    const io = cli(
      { "current.json": settings },
      JSON.stringify({ ...proposed, freshnessWeight: 90 }),
    );
    expect(await runCli(["settings-diff", "current.json", "-"], io)).toBe(1);
    expect(io.err).toBe(
      "The proposed settings document does not match the dashboard contract:\n- freshnessWeight: must be at most 50\n",
    );
    expect(io.out).toBe("");
  });

  it("needs two documents", async () => {
    const io = cli({});
    expect(await runCli(["settings-diff", "current.json"], io)).toBe(2);
    expect(await runCli(["settings-diff", "-", "x.json"], io)).toBe(2);
    expect(await runCli(["tune-report"], io)).toBe(2);
  });
});
