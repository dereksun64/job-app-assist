import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateApplicationDocument,
  type Card,
  type PreparedApplication,
  type Posting,
  type Settings,
} from "../contract/index.ts";
import { samplePosting } from "../contract/testing/fixtures.ts";
import { memoryFillIo } from "../fill/testing/memory-io.ts";
import type { Fetch } from "../refresh/job-feed.ts";
import { runPrepare, type PrepareIo } from "./run.ts";

const NOW = "2026-11-10T15:00:00.000Z";
const DIR = ".job-app-assist/refresh";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [{ name: "Software Engineer", priority: "high" }],
    seniority: ["new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City"] }],
  },
  resumeVariants: [
    { name: "Generalist SWE", roleTypes: [], keywords: [] },
    { name: "Backend SWE/SDE", roleTypes: [], keywords: ["backend"] },
  ],
  dailyQueueTarget: 20,
  companies: { boost: [], lower: [], block: [] },
  blockedApplySites: [],
  freshnessWeight: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const styleGuide = `# Style Guide

## Tone

Plain and warm. Short sentences.

## Phrases to avoid

- passionate about
- I am excited to
`;

const manifest = {
  variants: [
    { name: "Generalist SWE", file: "resumes/generalist.pdf" },
    { name: "Backend SWE/SDE", file: "resumes/backend.pdf" },
  ],
};

const figma = samplePosting({
  id: "00000000000a",
  company: "Figma",
  title: "Software Engineer, New Grad",
  applyUrl: "https://job-boards.greenhouse.io/figma/jobs/111",
});
const lever = samplePosting({
  id: "00000000000b",
  company: "Plaid",
  title: "Software Engineer",
  applyUrl: "https://jobs.lever.co/plaid/abc",
});
const quiet = samplePosting({
  id: "00000000000c",
  company: "Quiet Co",
  title: "Software Engineer",
  applyUrl: "https://boards.greenhouse.io/quiet/jobs/222",
  resumeVariant: { name: "Backend SWE/SDE", reason: "Backend role." },
});
const done = samplePosting({
  id: "00000000000d",
  company: "Done Inc",
  applyUrl: "https://boards.greenhouse.io/done/jobs/333",
});
const submitted = samplePosting({
  id: "00000000000e",
  company: "Old Co",
  applyUrl: "https://boards.greenhouse.io/old/jobs/444",
});

function card(of: Posting, overrides: Partial<Card> = {}): Card {
  return {
    schemaVersion: 1,
    postingId: of.id,
    stage: "queued",
    queuedAt: "2026-11-10T14:30:00.000Z",
    queuedBy: "refresh",
    posting: of,
    updatedAt: "2026-11-10T14:30:00.000Z",
    ...overrides,
  };
}

const json = (value: unknown) => `${JSON.stringify(value)}\n`;

const existing: PreparedApplication = {
  schemaVersion: 1,
  postingId: done.id,
  preparedAt: "2026-11-09T14:30:00.000Z",
  preparedBy: "refresh",
  questions: [],
  updatedAt: "2026-11-09T14:30:00.000Z",
};

const greenhouse: Record<string, unknown> = {
  "https://boards-api.greenhouse.io/v1/boards/figma/jobs/111?questions=true": {
    content: "&lt;p&gt;Join the Editor team building the canvas.&lt;/p&gt;",
    questions: [
      { required: true, label: "Email", fields: [{ name: "email", type: "input_text" }] },
      {
        required: true,
        label: "Why do you want to join Figma?",
        fields: [{ name: "question_1", type: "textarea" }],
      },
      {
        required: false,
        label: "Tell us about a project you are proud of.",
        fields: [{ name: "question_2", type: "textarea" }],
      },
    ],
  },
  "https://boards-api.greenhouse.io/v1/boards/quiet/jobs/222?questions=true": {
    questions: [
      { required: true, label: "Email", fields: [{ name: "email", type: "input_text" }] },
    ],
  },
};

function folder(extra: Record<string, string> = {}, routes = greenhouse) {
  const files: Record<string, string> = {
    "style-guide.md": styleGuide,
    ".job-app-assist/resume-variants.json": json(manifest),
    "resumes/generalist.pdf": "%PDF",
    "resumes/backend.pdf": "%PDF",
    [`${DIR}/state/settings/main.json`]: json(settings),
    // Carried over from earlier Refreshes:
    [`${DIR}/state/cards/${done.id}.json`]: json(card(done)),
    [`${DIR}/state/cards/${submitted.id}.json`]: json(card(submitted, { stage: "submitted" })),
    [`${DIR}/state/applications/${done.id}.json`]: json(existing),
    // Pre-queued by this Refresh:
    [`${DIR}/out/cards/${figma.id}.json`]: json(card(figma)),
    [`${DIR}/out/cards/${lever.id}.json`]: json(
      card(lever, { queuedAt: "2026-11-10T14:30:01.000Z" }),
    ),
    [`${DIR}/out/cards/${quiet.id}.json`]: json(
      card(quiet, { queuedAt: "2026-11-10T14:30:02.000Z" }),
    ),
    ...extra,
  };
  const seen: string[] = [];
  const fetch: Fetch = (url) => {
    seen.push(url);
    const body = routes[url];
    return Promise.resolve(
      body === undefined
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  };
  const io: PrepareIo & ReturnType<typeof memoryFillIo> = Object.assign(
    memoryFillIo(files, { now: NOW }),
    { fetch },
  );
  return { io, seen };
}

async function readJson<T>(io: PrepareIo, path: string): Promise<T> {
  return JSON.parse(await io.readFile(path)) as T;
}

const figmaAnswers = {
  questions: [
    {
      question: "Why do you want to join Figma?",
      type: "why_company",
      draft: "I design every side project in Figma first, so I know where it shines.",
    },
    {
      question: "Tell us about a project you are proud of.",
      type: "project",
      draft: "I built a course planner that 2,000 students at my school use each term.",
    },
  ],
  brief: {
    company: "Figma makes a collaborative design tool used by product teams.",
    news: [
      {
        headline: "Figma ships a new AI design feature",
        url: "https://www.theverge.com/figma-ai",
        source: "The Verge",
        publishedOn: "2026-11-01",
      },
    ],
    team: "The role sits on the Editor team, which builds the canvas.",
    fit: "Your course planner and TypeScript internship match the frontend focus.",
  },
};

describe("jaa prepare plan", () => {
  it("lists every Queued card without a Prepared Application, reading questions ahead where it can", async () => {
    const { io, seen } = folder();
    expect(await runPrepare(["plan", DIR], io)).toBe(0);

    const plan = await readJson<{ styleGuide: string; postings: unknown[]; later: unknown[] }>(
      io,
      `${DIR}/out/prepare-plan.json`,
    );
    expect(plan).toEqual({
      styleGuide: "style-guide.md",
      postings: [
        {
          postingId: figma.id,
          company: "Figma",
          title: "Software Engineer, New Grad",
          roleType: "Software Engineer",
          applyUrl: figma.applyUrl,
          resumeVariant: { name: "Generalist SWE", file: resolve("resumes/generalist.pdf") },
          description: "Join the Editor team building the canvas.",
          questions: [
            { question: "Why do you want to join Figma?", required: true },
            { question: "Tell us about a project you are proud of.", required: false },
          ],
          answersFile: `${DIR}/prepared/${figma.id}.json`,
        },
        {
          postingId: quiet.id,
          company: "Quiet Co",
          title: "Software Engineer",
          roleType: "Software Engineer",
          applyUrl: quiet.applyUrl,
          resumeVariant: { name: "Backend SWE/SDE", file: resolve("resumes/backend.pdf") },
          questions: [],
        },
      ],
      later: [
        {
          postingId: lever.id,
          company: "Plaid",
          title: "Software Engineer",
          reason: "jobs.lever.co does not list its questions ahead of the form",
        },
      ],
    });
    // Postings that already have one, or are past Queued, are never fetched.
    expect(seen).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/figma/jobs/111?questions=true",
      "https://boards-api.greenhouse.io/v1/boards/quiet/jobs/222?questions=true",
    ]);
    expect(io.out).toBe(
      [
        "3 Queued Postings have no Prepared Application:",
        `- Figma - Software Engineer, New Grad (${figma.id}): 2 free-text questions. Write ${DIR}/prepared/${figma.id}.json.`,
        `- Quiet Co - Software Engineer (${quiet.id}): no free-text questions, nothing to write.`,
        `- Plaid - Software Engineer (${lever.id}): Fill prepares it from the form (jobs.lever.co does not list its questions ahead of the form).`,
        `Plan saved to ${DIR}/out/prepare-plan.json.`,
        "",
      ].join("\n"),
    );
  });

  it("leaves a Posting to Fill when its questions cannot be read", async () => {
    const { io } = folder({}, {});
    expect(await runPrepare(["plan", DIR], io)).toBe(0);
    const plan = await readJson<{ postings: unknown[]; later: { reason: string }[] }>(
      io,
      `${DIR}/out/prepare-plan.json`,
    );
    expect(plan.postings).toEqual([]);
    expect(plan.later.map((p) => p.reason)).toEqual([
      "its questions could not be read: Greenhouse answered 404",
      "jobs.lever.co does not list its questions ahead of the form",
      "its questions could not be read: Greenhouse answered 404",
    ]);
  });

  it("needs the Style Guide first", async () => {
    const { io } = folder({ "style-guide.md": "# Style Guide\n\n## Tone\n\n" });
    expect(await runPrepare(["plan", DIR], io)).toBe(1);
    expect(io.err).toContain("style-guide.md has no tone yet");
  });

  it("says when every Queued card is prepared", async () => {
    const { io } = folder();
    for (const p of [figma, lever, quiet]) io.disk.delete(resolve(`${DIR}/out/cards/${p.id}.json`));
    expect(await runPrepare(["plan", DIR], io)).toBe(0);
    expect(io.out).toBe(
      `Every Queued Posting has a Prepared Application.\nPlan saved to ${DIR}/out/prepare-plan.json.\n`,
    );
  });
});

describe("jaa prepare build", () => {
  async function planned(extra: Record<string, string> = {}) {
    const { io } = folder(extra);
    expect(await runPrepare(["plan", DIR], io)).toBe(0);
    io.out = "";
    return io;
  }

  it("turns the drafted answers into Prepared Applications, each answer in its type's mode", async () => {
    const io = await planned({ [`${DIR}/prepared/${figma.id}.json`]: json(figmaAnswers) });
    expect(await runPrepare(["build", DIR], io)).toBe(0);

    const doc = await readJson<PreparedApplication>(io, `${DIR}/out/applications/${figma.id}.json`);
    expect(validateApplicationDocument(figma.id, doc).ok).toBe(true);
    expect(doc).toEqual({
      schemaVersion: 1,
      postingId: figma.id,
      preparedAt: NOW,
      preparedBy: "refresh",
      questions: [
        { ...figmaAnswers.questions[0], mode: "brief" },
        { ...figmaAnswers.questions[1], mode: "ai" },
      ],
      brief: figmaAnswers.brief,
      updatedAt: NOW,
    });
    const quietDoc = await readJson<PreparedApplication>(
      io,
      `${DIR}/out/applications/${quiet.id}.json`,
    );
    expect(quietDoc.questions).toEqual([]);
    expect(quietDoc).not.toHaveProperty("brief");

    expect(await readJson(io, `${DIR}/out/application-writes.json`)).toEqual({
      batches: [
        [
          {
            op: "set",
            collection: "applications",
            doc_id: figma.id,
            file_path: `${DIR}/out/applications/${figma.id}.json`,
          },
          {
            op: "set",
            collection: "applications",
            doc_id: quiet.id,
            file_path: `${DIR}/out/applications/${quiet.id}.json`,
          },
        ],
      ],
    });
    expect(io.out).toBe(
      [
        "2 Prepared Applications to write:",
        "- Figma - Software Engineer, New Grad: 1 AI-drafted answer, 1 Research Brief answer for you to write.",
        "- Quiet Co - Software Engineer: no free-text questions.",
        `Send the batch in ${DIR}/out/application-writes.json with ArtifactData.`,
        "",
      ].join("\n"),
    );
  });

  it("refuses a draft that uses a phrase the Style Guide avoids, writing nothing", async () => {
    const answers = structuredClone(figmaAnswers);
    const [, project] = answers.questions;
    if (project) project.draft = "I am passionate about  planners, so I built one.";
    const io = await planned({ [`${DIR}/prepared/${figma.id}.json`]: json(answers) });
    expect(await runPrepare(["build", DIR], io)).toBe(1);
    expect(io.err).toBe(
      [
        `${DIR}/prepared/${figma.id}.json needs fixing:`,
        '- "Tell us about a project you are proud of.": uses "passionate about", which your Style Guide avoids',
        "",
      ].join("\n"),
    );
    await expect(io.readFile(`${DIR}/out/application-writes.json`)).rejects.toThrow();
  });

  it("needs an answer for every question the form asks, and only those", async () => {
    const answers = structuredClone(figmaAnswers);
    answers.questions = [
      {
        question: "Why do you want to join Figma?",
        type: "why_company",
        draft: "I design every side project in Figma first.",
      },
      { question: "What is your favorite color?", type: "other", draft: "Blue." },
    ];
    const io = await planned({ [`${DIR}/prepared/${figma.id}.json`]: json(answers) });
    expect(await runPrepare(["build", DIR], io)).toBe(1);
    expect(io.err).toContain(
      '- "What is your favorite color?" is not on the form; answer only the questions the plan lists',
    );
    expect(io.err).toContain(
      '- "Tell us about a project you are proud of." has no answer; answer every question the plan lists',
    );
  });

  it("reports contract problems in the drafted file", async () => {
    const answers = structuredClone(figmaAnswers);
    const [item] = answers.brief.news;
    if (item) item.url = "http://example.com/story";
    const io = await planned({ [`${DIR}/prepared/${figma.id}.json`]: json(answers) });
    expect(await runPrepare(["build", DIR], io)).toBe(1);
    expect(io.err).toContain("- brief.news.0.url: must be an https URL");
  });

  it("leaves a Posting with no drafted file to Fill", async () => {
    const io = await planned();
    expect(await runPrepare(["build", DIR], io)).toBe(0);
    expect(io.out).toContain(
      `Not prepared, so Fill prepares it from the form:\n- Figma - Software Engineer, New Grad (no ${DIR}/prepared/${figma.id}.json)`,
    );
  });

  it("needs a plan first", async () => {
    const { io } = folder();
    expect(await runPrepare(["build", DIR], io)).toBe(1);
    expect(io.err).toContain(`Run jaa prepare plan ${DIR} first`);
  });
});

describe("jaa prepare build --posting, from Fill", () => {
  const FILL = ".job-app-assist/fill";

  function fillFolder(extra: Record<string, string> = {}) {
    const io = Object.assign(
      memoryFillIo(
        {
          "style-guide.md": styleGuide,
          [`${FILL}/state/cards/${lever.id}.json`]: json(card(lever)),
          [`${FILL}/state/cards/${done.id}.json`]: json(card(done)),
          [`${FILL}/state/applications/${done.id}.json`]: json(existing),
          ...extra,
        },
        { now: NOW },
      ),
      { fetch: () => Promise.reject(new Error("no network")) },
    );
    return io;
  }

  const leverAnswers = {
    questions: [
      {
        question: "Why Plaid?",
        type: "why_company",
        draft: "Plaid is the layer under the budgeting app I built.",
      },
      {
        question: "Additional information",
        type: "additional_info",
        draft: "I can start in June 2027.",
        maxLength: 500,
      },
    ],
    brief: { ...figmaAnswers.brief, company: "Plaid connects apps to bank accounts." },
  };

  it("prepares a card from the questions Fill read on the form, and prints what to type", async () => {
    const io = fillFolder({ [`${FILL}/prepared/${lever.id}.json`]: json(leverAnswers) });
    expect(await runPrepare(["build", FILL, "--posting", lever.id], io)).toBe(0);
    const doc = await readJson<PreparedApplication>(
      io,
      `${FILL}/out/applications/${lever.id}.json`,
    );
    expect(doc.preparedBy).toBe("fill");
    expect(doc.questions.map((q) => q.mode)).toEqual(["brief", "ai"]);
    expect(io.out).toBe(
      [
        "Plaid - Software Engineer: 1 AI-drafted answer, 1 Research Brief answer for you to write.",
        `Send the batch in ${FILL}/out/application-writes.json with ArtifactData.`,
        "Answers for the form:",
        '- "Why Plaid?": leave blank and flag it as free_text; the Candidate writes it under the Research Brief.',
        '- "Additional information" (AI-drafted): I can start in June 2027.',
        "",
      ].join("\n"),
    );
  });

  it("never replaces a Prepared Application that exists", async () => {
    const io = fillFolder({ [`${FILL}/prepared/${done.id}.json`]: json(leverAnswers) });
    expect(await runPrepare(["build", FILL, "--posting", done.id], io)).toBe(1);
    expect(io.err).toContain("already has a Prepared Application");
  });

  it("needs the card to be saved", async () => {
    const io = fillFolder();
    expect(await runPrepare(["build", FILL, "--posting", "0000000000ff"], io)).toBe(1);
    expect(io.err).toContain(`${FILL}/state/cards/0000000000ff.json is missing`);
  });
});

describe("usage", () => {
  it("rejects unknown steps and arguments", async () => {
    const { io } = folder();
    expect(await runPrepare(["draft", DIR], io)).toBe(2);
    expect(await runPrepare(["build", DIR, "--posting", "nope"], io)).toBe(2);
    expect(io.err).toContain("Usage: jaa prepare plan <dir>");
  });
});
