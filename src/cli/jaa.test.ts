import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./jaa.ts";

const validSettings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [{ name: "Software Engineer", priority: "high" }],
    seniority: ["new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["Remote"] }],
  },
  resumeVariants: [
    { name: "Generalist SWE", roleTypes: [], keywords: [] },
    { name: "Backend SWE/SDE", roleTypes: ["Software Engineer"], keywords: ["backend"] },
  ],
  dailyQueueTarget: 20,
  updatedAt: "2026-11-10T15:00:00.000Z",
};

function io(
  files: Record<string, string> = {},
  stdin = "",
  sizes: Record<string, number> = {},
): CliIo & { out: string; err: string } {
  const result = {
    out: "",
    err: "",
    readFile: (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return Promise.resolve(text);
    },
    writeFile: () => Promise.resolve(),
    readDir: () => Promise.resolve([]),
    makeDir: () => Promise.resolve(),
    removeDir: () => Promise.resolve(),
    fetch: () => Promise.reject(new Error("no network in tests")),
    now: () => "2026-11-10T15:00:00.000Z",
    timeZone: () => "UTC",
    sleep: () => Promise.resolve(),
    readStdin: () => Promise.resolve(stdin),
    fileSize: (path: string) => Promise.resolve(sizes[path]),
    env: () => undefined,
    homeDir: () => "/home/candidate",
    stdout: (text: string) => {
      result.out += text;
    },
    stderr: (text: string) => {
      result.err += text;
    },
  };
  return result;
}

describe("jaa validate", () => {
  it("accepts a valid document from a file", async () => {
    const cli = io({ "s.json": JSON.stringify(validSettings) });
    expect(await runCli(["validate", "settings", "main", "s.json"], cli)).toBe(0);
    expect(cli.out).toBe("settings/main matches the dashboard contract.\n");
    expect(cli.err).toBe("");
  });

  it("reads the document from stdin when the file is -", async () => {
    const cli = io({}, JSON.stringify(validSettings));
    expect(await runCli(["validate", "settings", "main", "-"], cli)).toBe(0);
  });

  it("lists every problem and exits 1 for an invalid document", async () => {
    const cli = io({}, JSON.stringify({ ...validSettings, dailyQueueTarget: 0, extra: true }));
    expect(await runCli(["validate", "settings", "main", "-"], cli)).toBe(1);
    expect(cli.err).toMatch(/^settings\/main does not match the dashboard contract:\n/);
    expect(cli.err).toContain("- dailyQueueTarget: must be at least 1\n");
    expect(cli.err).toContain("extra");
    expect(cli.out).toBe("");
  });

  it("rejects text that is not JSON", async () => {
    const cli = io({}, "roleTypes: SWE");
    expect(await runCli(["validate", "settings", "main", "-"], cli)).toBe(1);
    expect(cli.err).toMatch(/^The document is not valid JSON: /);
  });

  it("reports a missing file", async () => {
    const cli = io();
    expect(await runCli(["validate", "settings", "main", "nope.json"], cli)).toBe(1);
    expect(cli.err).toContain("Could not read nope.json");
  });

  it("rejects a collection outside the contract", async () => {
    const cli = io({}, "{}");
    expect(await runCli(["validate", "secrets", "x", "-"], cli)).toBe(1);
    expect(cli.err).toContain('"secrets" is not a collection in the dashboard contract.');
  });
});

describe("jaa usage", () => {
  it.each([
    [[]],
    [["validate", "settings"]],
    [["publish"]],
    [["refresh"]],
    [["refresh", "dir", "--feed"]],
    [["refresh", "dir", "--rerun", "--feed", "x"]],
    [["check-resumes"]],
    [["check-resumes", "m.json", "--settings"]],
    [["news"]],
    [["news", "publish", "dir"]],
    [["news", "plan"]],
    [["news", "build", "dir", "extra"]],
  ])("prints usage and exits 2 for %j", async (argv) => {
    const cli = io();
    expect(await runCli(argv, cli)).toBe(2);
    expect(cli.err).toContain("Usage: jaa validate <collection> <doc-id> <file|->");
  });

  it("prints usage on --help and exits 0", async () => {
    const cli = io();
    expect(await runCli(["--help"], cli)).toBe(0);
    expect(cli.out).toContain("Usage: jaa validate");
    expect(cli.out).toContain("jaa refresh <dir>");
    expect(cli.out).toContain("jaa news plan <dir>");
  });

  it("runs news build and asks for the plan first", async () => {
    const cli = io();
    expect(await runCli(["news", "build", "some/dir"], cli)).toBe(1);
    expect(cli.err).toContain("Run jaa news plan first.");
  });

  it("runs refresh and reports missing settings", async () => {
    const cli = io();
    expect(await runCli(["refresh", "some/dir"], cli)).toBe(1);
    expect(cli.err).toContain("No settings at");
  });
});

describe("jaa refresh --rerun", () => {
  it("accepts the flag and still needs settings", async () => {
    const cli = io();
    expect(await runCli(["refresh", "some/dir", "--rerun"], cli)).toBe(1);
    expect(cli.err).toContain("No settings at");
  });
});

describe("jaa check-resumes", () => {
  const manifest = {
    variants: [
      { name: "Generalist SWE", file: "resumes/generalist.pdf" },
      { name: "Backend SWE/SDE", file: "resumes/Backend Resume.docx" },
    ],
  };
  const sizes = { "resumes/generalist.pdf": 81_000, "resumes/Backend Resume.docx": 42_000 };
  const files = { "m.json": JSON.stringify(manifest) };

  it("confirms every Resume Variant file is in the Candidate folder", async () => {
    const cli = io(files, "", sizes);
    expect(await runCli(["check-resumes", "m.json"], cli)).toBe(0);
    expect(cli.out).toBe(
      "2 Resume Variants, every file found:\n- Generalist SWE: resumes/generalist.pdf\n- Backend SWE/SDE: resumes/Backend Resume.docx\n",
    );
  });

  it("checks the names match the settings document's Resume Variants, in order", async () => {
    const ok = io(files, JSON.stringify(validSettings), sizes);
    expect(await runCli(["check-resumes", "m.json", "--settings", "-"], ok)).toBe(0);
    const swapped = {
      ...validSettings,
      resumeVariants: [...validSettings.resumeVariants].reverse(),
    };
    const bad = io(files, JSON.stringify(swapped), sizes);
    expect(await runCli(["check-resumes", "m.json", "--settings", "-"], bad)).toBe(1);
    expect(bad.err).toContain(
      "The settings document lists Backend SWE/SDE, Generalist SWE; the Resume Variant files are for Generalist SWE, Backend SWE/SDE.",
    );
  });

  it.each<[string, unknown, string]>([
    [
      "a missing file",
      { variants: [{ name: "A", file: "resumes/a.pdf" }] },
      "resumes/a.pdf is not in the Candidate folder",
    ],
    ["no variants", { variants: [] }, "list at least one Resume Variant"],
    [
      "a file outside the Candidate folder",
      { variants: [{ name: "A", file: "../elsewhere/a.pdf" }] },
      "must be a path inside the Candidate folder",
    ],
    [
      "an absolute path",
      { variants: [{ name: "A", file: "/Users/me/a.pdf" }] },
      "inside the Candidate folder",
    ],
    [
      "a file type forms do not take",
      { variants: [{ name: "A", file: "resumes/a.pages" }] },
      "must be a PDF or Word file",
    ],
    [
      "the same name twice",
      {
        variants: [
          { name: "A", file: "resumes/generalist.pdf" },
          { name: "a", file: "resumes/Backend Resume.docx" },
        ],
      },
      "listed more than once",
    ],
  ])("refuses %s", async (_label, body, message) => {
    const cli = io({ "m.json": JSON.stringify(body) }, "", sizes);
    expect(await runCli(["check-resumes", "m.json"], cli)).toBe(1);
    expect(cli.err).toContain(message);
  });

  it("refuses an empty file", async () => {
    const cli = io(files, "", { ...sizes, "resumes/generalist.pdf": 0 });
    expect(await runCli(["check-resumes", "m.json"], cli)).toBe(1);
    expect(cli.err).toContain("resumes/generalist.pdf is empty");
  });
});

describe("jaa import-connections", () => {
  const EXPORT = [
    "Notes:",
    '"Some email addresses may be missing."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Priya,Shah,https://www.linkedin.com/in/priya,priya@example.com,Datadog,Software Engineer,08 Nov 2024",
    "Sam,Lee,https://www.linkedin.com/in/sam,sam@example.com,Datadog,Recruiter,15 Mar 2023",
    "Jo,Park,https://www.linkedin.com/in/jo,,,Student,02 Feb 2022",
  ].join("\n");

  function withDisk(files: Record<string, string>) {
    const cli = io(files);
    const written: Record<string, string> = {};
    cli.writeFile = (path, text) => {
      written[path] = text;
      return Promise.resolve();
    };
    return { cli, written };
  }

  it("keeps names, companies and positions, and leaves out email addresses and profile links", async () => {
    const { cli, written } = withDisk({ "Connections.csv": EXPORT });
    expect(
      await runCli(
        ["import-connections", "Connections.csv", ".job-app-assist/connections.json"],
        cli,
      ),
    ).toBe(0);
    expect(cli.err).toBe("");
    const file = written[".job-app-assist/connections.json"] ?? "";
    expect(JSON.parse(file)).toEqual({
      schemaVersion: 1,
      importedAt: "2026-11-10T15:00:00.000Z",
      connections: [
        {
          name: "Priya Shah",
          company: "Datadog",
          position: "Software Engineer",
          connectedOn: "2024-11-08",
        },
        { name: "Sam Lee", company: "Datadog", position: "Recruiter", connectedOn: "2023-03-15" },
      ],
    });
    expect(file).not.toContain("example.com");
    expect(file).not.toContain("linkedin.com");
    expect(cli.out).toBe(
      "Imported 2 connections at 1 company into .job-app-assist/connections.json. " +
        "1 connection with no company listed was left out.\n" +
        "Email addresses and profile links were not kept. The file stays on this computer; " +
        "the dashboard only ever holds the Referral Drafts made from it.\n",
    );
  });

  it("explains a file that is not a connections export, and writes nothing", async () => {
    const { cli, written } = withDisk({ "jobs.csv": "Name,Email\nPriya,p@example.com\n" });
    expect(await runCli(["import-connections", "jobs.csv", "out.json"], cli)).toBe(1);
    expect(cli.err).toContain("This is not a LinkedIn connections export");
    expect(written).toEqual({});
  });

  it("explains a file it cannot read", async () => {
    const { cli } = withDisk({});
    expect(await runCli(["import-connections", "missing.csv", "out.json"], cli)).toBe(1);
    expect(cli.err).toBe("Could not read missing.csv: ENOENT: no such file, open 'missing.csv'\n");
  });

  it.each([[["import-connections"]], [["import-connections", "Connections.csv"]]])(
    "prints usage for %j",
    async (argv) => {
      const cli = io();
      expect(await runCli(argv, cli)).toBe(2);
      expect(cli.err).toContain("Usage: jaa validate");
    },
  );
});

describe("jaa private-answers and jaa fill", () => {
  it("runs the private-answers steps and checks their arguments", async () => {
    const cli = io({ "private-answers.md": "- Legal first name: Sam\n" });
    expect(await runCli(["private-answers", "check", "private-answers.md"], cli)).toBe(0);
    expect(cli.out).toBe("private-answers.md answers every question.\n");
    expect(await runCli(["private-answers", "show", "private-answers.md"], cli)).toBe(2);
    expect(await runCli(["private-answers", "init"], cli)).toBe(2);
  });

  it("runs the fill steps", async () => {
    const cli = io();
    expect(await runCli(["fill", "plan", ".job-app-assist/fill"], cli)).toBe(1);
    expect(cli.err).toContain("There is no private-answers.md in the Candidate folder");
    expect(await runCli(["fill"], cli)).toBe(2);
  });

  it("lists the new commands in its help", async () => {
    const cli = io();
    expect(await runCli(["--help"], cli)).toBe(0);
    expect(cli.out).toContain("jaa private-answers init|check <file>");
    expect(cli.out).toContain("jaa fill plan <dir> [--posting <words|id|apply URL>]");
    expect(cli.out).toContain("jaa fill finish <dir> <posting-id> --version <n>");
  });
});
