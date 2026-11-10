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
    readStdin: () => Promise.resolve(stdin),
    fileSize: (path: string) => Promise.resolve(sizes[path]),
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
