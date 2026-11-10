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
  dailyQueueTarget: 20,
  updatedAt: "2026-11-10T15:00:00.000Z",
};

function io(files: Record<string, string> = {}, stdin = ""): CliIo & { out: string; err: string } {
  const result = {
    out: "",
    err: "",
    readFile: (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return Promise.resolve(text);
    },
    readStdin: () => Promise.resolve(stdin),
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
  it.each([[[]], [["validate", "settings"]], [["publish"]]])(
    "prints usage and exits 2 for %j",
    async (argv) => {
      const cli = io();
      expect(await runCli(argv, cli)).toBe(2);
      expect(cli.err).toContain("Usage: jaa validate <collection> <doc-id> <file|->");
    },
  );

  it("prints usage on --help and exits 0", async () => {
    const cli = io();
    expect(await runCli(["--help"], cli)).toBe(0);
    expect(cli.out).toContain("Usage: jaa validate");
  });
});
