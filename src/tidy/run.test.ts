import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { samplePosting } from "../contract/testing/fixtures.ts";
import { memoryFillIo } from "../fill/testing/memory-io.ts";
import { runTidy, type TidyIo } from "./run.ts";

const DIR = ".job-app-assist/tidy";
const NOW = "2026-11-10T15:00:00.000Z";
const OLD = "2026-09-01T00:00:00.000Z";

const posting = (id: string, company: string) =>
  samplePosting({
    id,
    company,
    title: "Software Engineer, New Grad",
    applyUrl: `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${id}`,
  });

const card = (id: string, company: string, stage: string, changed = OLD) =>
  JSON.stringify({
    schemaVersion: 1,
    postingId: id,
    stage,
    ...(stage === "closed" ? { closedReason: "rejected" } : {}),
    queuedAt: "2026-08-01T00:00:00.000Z",
    queuedBy: "refresh",
    stageChangedAt: changed,
    posting: posting(id, company),
    updatedAt: changed,
  });

function setup(extra: Record<string, string> = {}) {
  const io = memoryFillIo(
    {
      [`${DIR}/state/settings/main.json`]: "{}",
      [`${DIR}/state/sources/job-feed.json`]: "{}",
      [`${DIR}/state/cards/aaaaaaaaaaaa.json`]: card("aaaaaaaaaaaa", "Acme", "closed"),
      [`${DIR}/state/cards/bbbbbbbbbbbb.json`]: card("bbbbbbbbbbbb", "Brainy", "submitted"),
      [`${DIR}/state/applications/aaaaaaaaaaaa.json`]: '{"questions":[]}',
      [`${DIR}/state/applications/bbbbbbbbbbbb.json`]: '{"questions":[]}',
      ...extra,
    },
    { now: NOW },
  );
  const tidyIo: TidyIo & typeof io = Object.assign(io, {
    timeZone: () => "America/New_York",
    removeDir: (path: string) => {
      for (const key of [...io.disk.keys()]) {
        if (key.startsWith(`${resolve(path)}/`)) io.disk.delete(key);
      }
      return Promise.resolve();
    },
  });
  return tidyIo;
}

const json = (io: ReturnType<typeof setup>, path: string) =>
  JSON.parse(io.disk.get(resolve(path)) ?? "null") as unknown;

describe("jaa tidy plan", () => {
  it("lists what it would remove for the Candidate to approve, and writes nothing else", async () => {
    const io = setup();
    expect(await runTidy(["plan", DIR], io)).toBe(0);
    expect(io.out).toContain("Closed cards closed 30 or more days ago: 1");
    expect(io.out).toContain("Acme, Software Engineer, New Grad (rejected)");
    expect(io.out).toContain("6 documents now, 4 after");
    expect(io.out).toContain("Nothing is removed until the Candidate approves");
    expect(json(io, `${DIR}/out/tidy-plan.json`)).toEqual({
      deletes: [
        { collection: "cards", docId: "aaaaaaaaaaaa" },
        { collection: "applications", docId: "aaaaaaaaaaaa" },
      ],
    });
  });

  it("keeps the documents of a card it cannot read", async () => {
    const io = setup({ [`${DIR}/state/cards/aaaaaaaaaaaa.json`]: '{"stage":"closed"}' });
    expect(await runTidy(["plan", DIR], io)).toBe(0);
    expect(json(io, `${DIR}/out/tidy-plan.json`)).toEqual({ deletes: [] });
  });

  it("takes a shorter wait for Closed cards when the Candidate asks", async () => {
    const recent = new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString();
    const io = setup({
      [`${DIR}/state/cards/cccccccccccc.json`]: card("cccccccccccc", "Cobalt", "closed", recent),
    });
    expect(await runTidy(["plan", DIR, "--closed-days", "0"], io)).toBe(0);
    expect(io.out).toContain("Closed cards closed 0 or more days ago: 2");
  });

  it("says plainly when there is nothing to remove, and what else would help", async () => {
    const io = memoryFillIo({ [`${DIR}/state/settings/main.json`]: "{}" }, { now: NOW });
    const tidyIo = Object.assign(io, {
      timeZone: () => "UTC",
      removeDir: () => Promise.resolve(),
    });
    expect(await runTidy(["plan", DIR], tidyIo)).toBe(0);
    expect(tidyIo.out).toContain("Nothing to remove");
    expect(tidyIo.out).toContain("--closed-days 0");
    expect(JSON.parse(tidyIo.disk.get(resolve(`${DIR}/out/tidy-plan.json`)) ?? "")).toEqual({
      deletes: [],
    });
  });
});

describe("jaa tidy build", () => {
  it("pins each removal to the version the Candidate's dashboard reported", async () => {
    const io = setup();
    await runTidy(["plan", DIR], io);
    io.disk.set(
      resolve(`${DIR}/versions.json`),
      JSON.stringify({ "cards/aaaaaaaaaaaa": 4, "applications/aaaaaaaaaaaa": 2 }),
    );
    expect(await runTidy(["build", DIR], io)).toBe(0);
    expect(json(io, `${DIR}/out/writes.json`)).toEqual({
      batches: [
        [
          { op: "delete", collection: "cards", doc_id: "aaaaaaaaaaaa", if_version: 4 },
          { op: "delete", collection: "applications", doc_id: "aaaaaaaaaaaa", if_version: 2 },
        ],
      ],
    });
    expect(io.out).toContain("Send the 1 batch");
  });

  it("names every removal still missing its version", async () => {
    const io = setup();
    await runTidy(["plan", DIR], io);
    io.disk.set(resolve(`${DIR}/versions.json`), JSON.stringify({ "cards/aaaaaaaaaaaa": 4 }));
    expect(await runTidy(["build", DIR], io)).toBe(1);
    expect(io.err).toContain("applications/aaaaaaaaaaaa");
    expect(io.disk.has(resolve(`${DIR}/out/writes.json`))).toBe(false);
  });

  it("needs a plan first", async () => {
    const io = setup();
    expect(await runTidy(["build", DIR], io)).toBe(1);
    expect(io.err).toContain("jaa tidy plan");
  });
});
