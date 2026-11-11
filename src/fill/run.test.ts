import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateCard,
  type Card,
  type FinalAnswer,
  type Posting,
  type PreparedApplication,
  type Settings,
} from "../contract/index.ts";
import { samplePosting } from "../contract/testing/fixtures.ts";
import { PRIVATE_ANSWERS_TEMPLATE } from "./private-answers.ts";
import { runFill } from "./run.ts";
import { memoryFillIo } from "./testing/memory-io.ts";

const NOW = "2026-11-12T10:00:00.000Z";
const DIR = ".job-app-assist/fill";
const SESSION = "5e55a0b1-0000-4000-8000-000000000001";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [{ name: "Software Engineer", priority: "high" }],
    seniority: ["new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City"] }, { locations: ["Boston"] }],
  },
  resumeVariants: [
    { name: "Generalist SWE", roleTypes: [], keywords: [] },
    { name: "Backend SWE/SDE", roleTypes: ["Software Engineer"], keywords: ["backend"] },
  ],
  dailyQueueTarget: 20,
  companies: { boost: [], lower: [], block: [] },
  blockedApplySites: [],
  freshnessWeight: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const manifest = {
  variants: [
    { name: "Generalist SWE", file: "resumes/generalist.pdf" },
    { name: "Backend SWE/SDE", file: "resumes/backend.pdf" },
  ],
};

function posting(n: number, overrides: Partial<Posting> = {}): Posting {
  return samplePosting({
    id: n.toString(16).padStart(12, "0"),
    applyUrl: `https://job-boards.greenhouse.io/company${String(n)}/jobs/${String(n)}`,
    company: `Company ${String(n)}`,
    ...overrides,
  });
}

function card(of: Posting, overrides: Partial<Card> = {}): Card {
  return {
    schemaVersion: 1,
    postingId: of.id,
    stage: "queued",
    queuedAt: "2026-11-11T09:00:00.000Z",
    queuedBy: "refresh",
    posting: of,
    updatedAt: "2026-11-11T09:00:00.000Z",
    ...overrides,
  };
}

const json = (value: unknown) => `${JSON.stringify(value)}\n`;

function candidateFolder(cards: Card[], extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    "private-answers.md": PRIVATE_ANSWERS_TEMPLATE,
    ".job-app-assist/resume-variants.json": json(manifest),
    "resumes/generalist.pdf": "%PDF generalist",
    "resumes/backend.pdf": "%PDF backend",
    [`${DIR}/state/settings/main.json`]: json(settings),
    ...extra,
  };
  for (const c of cards) files[`${DIR}/state/cards/${c.postingId}.json`] = json(c);
  return memoryFillIo(files, {
    now: NOW,
    env: { CLAUDE_CODE_SESSION_ID: SESSION },
    home: "/home/candidate",
  });
}

async function readJson<T>(
  io: { readFile(path: string): Promise<string> },
  path: string,
): Promise<T> {
  return JSON.parse(await io.readFile(path)) as T;
}

interface PlanFile {
  postings: {
    postingId: string;
    company: string;
    title: string;
    applyUrl: string;
    resumeVariant: { name: string; file: string; byCandidate: boolean };
    signInLikely?: string;
    fillingSince?: string;
    answers?: FinalAnswer[];
  }[];
}

describe("jaa fill plan", () => {
  const first = posting(1, { locationTier: 2 });
  const second = posting(2, { locationTier: 1, title: "Backend Engineer, New Grad" });
  const older = posting(3);
  const reviewed = posting(4);

  it("lists the Queued cards in Queue order with each one's Resume Variant file", async () => {
    const io = candidateFolder([
      card(first),
      card(second),
      card(older, { queuedAt: "2026-11-10T09:00:00.000Z" }),
      card(reviewed, { stage: "ready_for_review", stageChangedAt: "2026-11-11T10:00:00.000Z" }),
    ]);
    expect(await runFill(["plan", DIR], io)).toBe(0);
    const plan = await readJson<PlanFile>(io, `${DIR}/out/plan.json`);
    expect(plan.postings.map((p) => p.postingId)).toEqual([older.id, second.id, first.id]);
    expect(plan.postings[0]).toEqual({
      postingId: older.id,
      company: older.company,
      title: older.title,
      applyUrl: older.applyUrl,
      resumeVariant: {
        name: "Generalist SWE",
        file: resolve("resumes/generalist.pdf"),
        byCandidate: false,
      },
    });
    expect(io.out).toContain("3 Queued Postings to fill, in Queue order:");
    expect(io.out).toContain(`1. Company 3 - Software Engineer, New Grad (${older.id})`);
    expect(io.out).toContain(`Plan saved to ${DIR}/out/plan.json.`);
  });

  it("uses the Resume Variant the Candidate chose in the drawer", async () => {
    const io = candidateFolder([card(first)], {
      [`${DIR}/state/variantOverrides/${first.id}.json`]: json({
        schemaVersion: 1,
        variant: "Backend SWE/SDE",
        chosenAt: "2026-11-11T12:00:00.000Z",
      }),
    });
    expect(await runFill(["plan", DIR], io)).toBe(0);
    const plan = await readJson<PlanFile>(io, `${DIR}/out/plan.json`);
    expect(plan.postings[0]?.resumeVariant).toEqual({
      name: "Backend SWE/SDE",
      file: resolve("resumes/backend.pdf"),
      byCandidate: true,
    });
    expect(io.out).toContain("Resume Variant: Backend SWE/SDE (your choice)");
  });

  it("points out sites that usually need a sign-in, and cards left filling", async () => {
    const workday = posting(5, {
      applyUrl: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/123",
    });
    const io = candidateFolder([card(workday, { fillingSince: "2026-11-11T20:00:00.000Z" })]);
    expect(await runFill(["plan", DIR], io)).toBe(0);
    const plan = await readJson<PlanFile>(io, `${DIR}/out/plan.json`);
    expect(plan.postings[0]?.signInLikely).toBe("Workday");
    expect(plan.postings[0]?.fillingSince).toBe("2026-11-11T20:00:00.000Z");
    expect(io.out).toContain("Usually needs a sign-in: Workday");
    expect(io.out).toContain("Still marked as filling from an earlier Fill");
  });

  it("carries each Prepared Application's final answers, and says which cards have none", async () => {
    const application: PreparedApplication = {
      schemaVersion: 1,
      postingId: first.id,
      preparedAt: "2026-11-11T09:00:00.000Z",
      preparedBy: "refresh",
      questions: [
        {
          question: "Why Company 1?",
          type: "why_company",
          mode: "brief",
          draft: "An AI draft Fill must not type.",
        },
        {
          question: "Anything else?",
          type: "additional_info",
          mode: "ai",
          draft: "I can start in June 2027.",
          editedAt: "2026-11-11T12:00:00.000Z",
        },
      ],
      brief: {
        company: "Company 1 makes things.",
        news: [],
        team: "The platform team.",
        fit: "Your backend internship fits.",
      },
      updatedAt: "2026-11-11T12:00:00.000Z",
    };
    const io = candidateFolder([card(first), card(second)], {
      [`${DIR}/state/applications/${first.id}.json`]: json(application),
    });
    expect(await runFill(["plan", DIR], io)).toBe(0);
    const plan = await readJson<PlanFile>(io, `${DIR}/out/plan.json`);
    const byId = new Map(plan.postings.map((p) => [p.postingId, p]));
    expect(byId.get(first.id)?.answers).toEqual([
      { question: "Why Company 1?", mode: "brief", answer: null, source: "none" },
      {
        question: "Anything else?",
        mode: "ai",
        answer: "I can start in June 2027.",
        source: "edited",
      },
    ]);
    expect(byId.get(second.id)).not.toHaveProperty("answers");
    expect(io.out).toContain(
      "   Prepared Application: 1 answer to type, 1 brief-mode answer the Candidate has not written",
    );
    expect(io.out).toContain("   No Prepared Application yet: prepare it from the form");
  });

  it("says so when the Queue is empty", async () => {
    const io = candidateFolder([card(reviewed, { stage: "submitted" })]);
    expect(await runFill(["plan", DIR], io)).toBe(0);
    expect((await readJson<PlanFile>(io, `${DIR}/out/plan.json`)).postings).toEqual([]);
    expect(io.out).toContain("Your Queue is empty");
  });

  describe("--posting, to fill one named Posting", () => {
    const acme = posting(6, { company: "Acme Robotics", title: "Software Engineer, New Grad" });
    const acmeMl = posting(7, { company: "Acme Robotics", title: "Machine Learning Engineer" });
    const beta = posting(8, { company: "Beta", applyUrl: "https://jobs.lever.co/beta/abc" });
    const cards = [card(acme), card(acmeMl), card(beta)];

    it.each([
      ["words from the company and title", "acme software"],
      ["the Posting id", acme.id],
      ["the apply URL", `${acme.applyUrl}?gh_src=feed`],
    ])("matches by %s", async (_, query) => {
      const io = candidateFolder(cards);
      expect(await runFill(["plan", DIR, "--posting", query], io)).toBe(0);
      const plan = await readJson<PlanFile>(io, `${DIR}/out/plan.json`);
      expect(plan.postings.map((p) => p.postingId)).toEqual([acme.id]);
      expect(io.out).toContain("1 Queued Posting to fill:");
    });

    it("lists the matches when the words fit more than one", async () => {
      const io = candidateFolder(cards);
      expect(await runFill(["plan", DIR, "--posting", "acme"], io)).toBe(1);
      expect(io.err).toContain('"acme" matches 2 Queued Postings; say which one:');
      expect(io.err).toContain(`- Acme Robotics - Machine Learning Engineer (${acmeMl.id})`);
    });

    it("says when the named Posting is not Queued", async () => {
      const io = candidateFolder([card(beta, { stage: "ready_for_review" })]);
      expect(await runFill(["plan", DIR, "--posting", "beta"], io)).toBe(1);
      expect(io.err).toContain(
        "Beta - Software Engineer, New Grad is Ready for Review, not Queued. Drag it back to Queued on the board to fill it again.",
      );
    });

    it("says when nothing matches", async () => {
      const io = candidateFolder(cards);
      expect(await runFill(["plan", DIR, "--posting", "gamma"], io)).toBe(1);
      expect(io.err).toContain('No card on your board matches "gamma".');
    });
  });

  it("sends the Candidate to Setup when the private file is missing", async () => {
    const io = candidateFolder([card(first)]);
    io.disk.delete(resolve("private-answers.md"));
    expect(await runFill(["plan", DIR], io)).toBe(1);
    expect(io.err).toContain("There is no private-answers.md in the Candidate folder");
    expect(io.err).toContain("/job-app-assist:setup");
  });

  it("sends the Candidate to Setup when the settings or Resume Variant files are missing", async () => {
    const noSettings = candidateFolder([card(first)]);
    noSettings.disk.delete(resolve(`${DIR}/state/settings/main.json`));
    expect(await runFill(["plan", DIR], noSettings)).toBe(1);
    expect(noSettings.err).toContain("/job-app-assist:setup");

    const noManifest = candidateFolder([card(first)]);
    noManifest.disk.delete(resolve(".job-app-assist/resume-variants.json"));
    expect(await runFill(["plan", DIR], noManifest)).toBe(1);
    expect(noManifest.err).toContain(".job-app-assist/resume-variants.json");
    expect(noManifest.err).toContain("/job-app-assist:setup");
  });

  it("stops when a chosen Resume Variant's file is missing", async () => {
    const io = candidateFolder([card(first)]);
    io.disk.delete(resolve("resumes/generalist.pdf"));
    expect(await runFill(["plan", DIR], io)).toBe(1);
    expect(io.err).toContain(
      "resumes/generalist.pdf (Generalist SWE) is not in the Candidate folder",
    );
  });

  it("stops when a Posting's Resume Variant has no file", async () => {
    const io = candidateFolder([
      card(posting(9, { resumeVariant: { name: "Data", reason: "Old." } })),
    ]);
    expect(await runFill(["plan", DIR], io)).toBe(1);
    expect(io.err).toContain("No Resume Variant file is recorded for Data");
  });
});

describe("jaa fill start", () => {
  const p = posting(1);

  it("marks the card as filling and writes the batch that saves it", async () => {
    const io = candidateFolder([card(p)]);
    expect(await runFill(["start", DIR, p.id, "--version", "3"], io)).toBe(0);
    const saved = await readJson<Card>(io, `${DIR}/out/cards/${p.id}.json`);
    expect(saved).toEqual({ ...card(p), fillingSince: NOW, updatedAt: NOW });
    expect(await readJson(io, `${DIR}/out/writes.json`)).toEqual({
      batches: [
        [
          {
            op: "set",
            collection: "cards",
            doc_id: p.id,
            file_path: `${DIR}/out/cards/${p.id}.json`,
            if_version: 3,
          },
        ],
      ],
    });
    expect(await readJson(io, `${DIR}/started/${p.id}.json`)).toEqual({ startedAt: NOW });
    expect(io.out).toContain(`Send the batch in ${DIR}/out/writes.json`);
  });

  it("refuses a card that is not Queued", async () => {
    const io = candidateFolder([card(p, { stage: "submitted" })]);
    expect(await runFill(["start", DIR, p.id, "--version", "3"], io)).toBe(1);
    expect(io.err).toContain("Fill works only on Queued cards; this one is Submitted.");
  });

  it("needs the card saved and its version", async () => {
    const io = candidateFolder([]);
    expect(await runFill(["start", DIR, p.id, "--version", "3"], io)).toBe(1);
    expect(io.err).toContain(`${DIR}/state/cards/${p.id}.json`);
    expect(await runFill(["start", DIR, p.id], io)).toBe(2);
  });
});

describe("jaa fill finish", () => {
  const p = posting(1, { company: "Acme", title: "Software Engineer, New Grad" });
  const FINISHED = "2026-11-12T10:06:00.000Z";
  const result = {
    outcome: "filled",
    simplify: "filled",
    resumeVariant: "Generalist SWE",
    flags: [
      { field: "Why Acme?", kind: "free_text", note: "Write this answer yourself." },
      {
        field: "Do you meet the basic qualifications?",
        kind: "legal_claim",
        note: "A claim about you; answer it yourself.",
      },
    ],
  };
  const transcript = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-12T10:01:00.000Z",
      message: {
        id: "m1",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 40000,
          output_tokens: 900,
        },
      },
    }),
  ].join("\n");

  async function finished(extra: Record<string, string>, start = true) {
    const io = candidateFolder([card(p, { fillingSince: NOW, updatedAt: NOW })], {
      [`${DIR}/results/${p.id}.json`]: json(result),
      [`/home/candidate/.claude/projects/-Users-sam-jobs/${SESSION}.jsonl`]: transcript,
      ...extra,
    });
    if (start) await io.writeFile(`${DIR}/started/${p.id}.json`, json({ startedAt: NOW }));
    io.setNow(FINISHED);
    return io;
  }

  it("moves a filled card to Ready for Review with its flags", async () => {
    const io = await finished({});
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(0);
    const saved = await readJson<Card>(io, `${DIR}/out/cards/${p.id}.json`);
    expect(validateCard(saved).ok).toBe(true);
    expect(saved.stage).toBe("ready_for_review");
    expect(saved).not.toHaveProperty("fillingSince");
    expect(saved.fill).toEqual({ at: FINISHED, ...result });
    expect(await readJson(io, `${DIR}/out/writes.json`)).toEqual({
      batches: [
        [
          {
            op: "set",
            collection: "cards",
            doc_id: p.id,
            file_path: `${DIR}/out/cards/${p.id}.json`,
            if_version: 4,
          },
        ],
      ],
    });
    expect(io.out).toContain(
      "Acme - Software Engineer, New Grad: filled, moving to Ready for Review with 2 flags.",
    );
  });

  it("logs the application's token use on this computer", async () => {
    const io = await finished({});
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(0);
    const log = (await io.readFile(`${DIR}/usage.jsonl`)).trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] ?? "")).toEqual({
      postingId: p.id,
      company: "Acme",
      title: "Software Engineer, New Grad",
      startedAt: NOW,
      finishedAt: FINISHED,
      outcome: "filled",
      simplify: "filled",
      flags: 2,
      tokens: {
        input: 10,
        cacheCreation: 2000,
        cacheRead: 40000,
        output: 900,
        total: 42910,
        messages: 1,
      },
    });
    expect(io.out).toContain(
      "Tokens for this application: 42,910 over 1 response (40,000 cache reads, 2,000 cache writes, 10 input, 900 output).",
    );
    expect(io.out).toContain("1 filled application logged so far, averaging 42,910 tokens each.");
  });

  it("averages over every filled application in the log", async () => {
    const earlier =
      json({ outcome: "filled", tokens: { total: 57090 } }) +
      json({ outcome: "needs_sign_in", tokens: { total: 5 } });
    const io = await finished({ [`${DIR}/usage.jsonl`]: earlier });
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(0);
    expect(io.out).toContain("2 filled applications logged so far, averaging 50,000 tokens each.");
    expect((await io.readFile(`${DIR}/usage.jsonl`)).trim().split("\n")).toHaveLength(3);
  });

  it("still finishes when the tokens cannot be counted", async () => {
    const io = await finished({}, false);
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(0);
    expect(io.out).toContain("Token use for this application could not be measured");
    const entry = JSON.parse((await io.readFile(`${DIR}/usage.jsonl`)).trim()) as {
      tokens: unknown;
    };
    expect(entry.tokens).toBeNull();
  });

  it("leaves a Posting that needs a sign-in Queued with its flag", async () => {
    const io = await finished({
      [`${DIR}/results/${p.id}.json`]: json({
        outcome: "needs_sign_in",
        simplify: "not_tried",
        flags: [
          {
            field: "Workday account",
            kind: "sign_in",
            note: "Sign in to Workday in Helium, then ask your Claude to fill this Posting again.",
          },
        ],
      }),
    });
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(0);
    const saved = await readJson<Card>(io, `${DIR}/out/cards/${p.id}.json`);
    expect(saved.stage).toBe("queued");
    expect(saved).not.toHaveProperty("fillingSince");
    expect(io.out).toContain(
      "Acme - Software Engineer, New Grad: needs a sign-in, staying Queued with 1 flag.",
    );
  });

  it("leaves a card Fill stopped on Queued, saying why", async () => {
    const io = await finished({
      [`${DIR}/results/${p.id}.json`]: json({
        outcome: "stopped",
        simplify: "not_tried",
        flags: [{ field: "Posting", kind: "problem", note: "The page says this job is closed." }],
      }),
    });
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(0);
    expect((await readJson<Card>(io, `${DIR}/out/cards/${p.id}.json`)).stage).toBe("queued");
    expect(io.out).toContain(
      "Acme - Software Engineer, New Grad: Fill stopped, staying Queued with 1 flag.",
    );
  });

  it("rejects a result that does not match the contract, and writes nothing", async () => {
    const io = await finished({
      [`${DIR}/results/${p.id}.json`]: json({
        ...result,
        flags: [{ field: "Gender", kind: "legal_claim", note: "Left blank.", value: "Female" }],
      }),
    });
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(1);
    expect(io.err).toContain(`${DIR}/results/${p.id}.json needs fixing:`);
    expect(io.err).toContain("fill.flags.0");
    expect(io.disk.has(resolve(`${DIR}/out/writes.json`))).toBe(false);
    expect(io.disk.has(resolve(`${DIR}/usage.jsonl`))).toBe(false);
  });

  it("needs the result file", async () => {
    const io = await finished({});
    io.disk.delete(resolve(`${DIR}/results/${p.id}.json`));
    expect(await runFill(["finish", DIR, p.id, "--version", "4"], io)).toBe(1);
    expect(io.err).toContain(`${DIR}/results/${p.id}.json`);
  });
});

describe("usage", () => {
  it("prints usage for unknown steps", async () => {
    const io = candidateFolder([]);
    expect(await runFill(["fly", DIR], io)).toBe(2);
    expect(await runFill(["plan"], io)).toBe(2);
    expect(await runFill(["start", DIR, "not-an-id", "--version", "1"], io)).toBe(2);
    expect(await runFill(["start", DIR, "0123456789ab", "--version", "0"], io)).toBe(2);
  });
});
