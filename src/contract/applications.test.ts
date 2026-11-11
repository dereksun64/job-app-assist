import { describe, expect, it } from "vitest";
import {
  ANSWER_MODES,
  QUESTION_TYPES,
  defaultMode,
  editAnswer,
  finalAnswers,
  recruiterSearchUrl,
  switchMode,
  validateApplication,
  validateApplicationDocument,
  validateDocument,
  writeOwnAnswer,
  type PreparedApplication,
} from "./index.ts";

const AT = "2026-11-10T14:30:00.000Z";
const LATER = "2026-11-10T18:00:00.000Z";

function application(overrides: Partial<PreparedApplication> = {}): PreparedApplication {
  return {
    schemaVersion: 1,
    postingId: "0123456789ab",
    preparedAt: AT,
    preparedBy: "refresh",
    questions: [
      {
        question: "Why do you want to join Acme?",
        type: "why_company",
        mode: "brief",
        draft: "Acme's tools are the ones I reach for first when I sketch an idea.",
      },
      {
        question: "Tell us about a project you are proud of.",
        type: "project",
        mode: "ai",
        draft: "I built a course planner that 2,000 students at my school use each term.",
      },
    ],
    brief: {
      company: "Acme makes collaborative design tools for product teams.",
      news: [
        {
          headline: "Acme opens a New York office",
          url: "https://www.reuters.com/technology/acme-new-york/",
          source: "Reuters",
          publishedOn: "2026-10-30",
        },
      ],
      team: "The role sits on the Editor team, which builds the canvas.",
      fit: "Your course planner and TypeScript internship match the frontend focus.",
    },
    updatedAt: AT,
    ...overrides,
  };
}

describe("Prepared Application documents", () => {
  it("accepts a Prepared Application with AI-drafted and brief-mode answers", () => {
    expect(validateApplication(application())).toEqual({ ok: true, value: application() });
    expect(validateDocument("applications", "0123456789ab", application()).ok).toBe(true);
  });

  it("accepts a Posting whose form has no free-text questions, without a brief", () => {
    const none = application({ questions: [] });
    delete none.brief;
    expect(validateApplication(none).ok).toBe(true);
  });

  it("needs a Research Brief whenever there is a question to answer", () => {
    const missing = application();
    delete missing.brief;
    expect(validateApplication(missing)).toEqual({
      ok: false,
      issues: ["brief: questions need a Research Brief, so any answer can switch to brief mode"],
    });
  });

  it("is stored under its Posting's id", () => {
    expect(validateApplicationDocument("ba9876543210", application())).toEqual({
      ok: false,
      issues: [
        "A Prepared Application is stored under its Posting's id: applications/0123456789ab, not applications/ba9876543210.",
      ],
    });
  });

  it("rejects fields outside the contract, so no sensitive answer can ride along", () => {
    const extra = { ...application(), legalAddress: "1 Main St" };
    expect(validateApplication(extra).ok).toBe(false);
    const question = application();
    Object.assign(question.questions[0] ?? {}, { privateAnswer: "Yes" });
    expect(validateApplication(question).ok).toBe(false);
  });

  it("keeps each answer within the form's limit", () => {
    const limited = application();
    const [first] = limited.questions;
    if (first) Object.assign(first, { maxLength: 20 });
    expect(validateApplication(limited)).toEqual({
      ok: false,
      issues: ["questions.0.draft: must be 20 characters or fewer, the form's limit"],
    });
  });

  it("links news only over https", () => {
    const insecure = application();
    const [item] = insecure.brief?.news ?? [];
    if (item) item.url = "http://example.com/story";
    expect(validateApplication(insecure).ok).toBe(false);
  });

  it("lets no two questions share a wording", () => {
    const [first] = application().questions;
    const twice = application({ questions: first ? [first, { ...first }] : [] });
    expect(validateApplication(twice).ok).toBe(false);
  });
});

describe("answer modes", () => {
  it("defaults company- and role-specific questions to a Research Brief, the rest to AI", () => {
    expect(ANSWER_MODES).toEqual(["ai", "brief"]);
    const briefs = QUESTION_TYPES.filter((type) => defaultMode(type) === "brief");
    expect(briefs).toEqual(["why_company", "why_role"]);
    expect(defaultMode("project")).toBe("ai");
    expect(defaultMode("additional_info")).toBe("ai");
  });

  it("switches one question's mode and keeps both texts", () => {
    const switched = switchMode(application(), 0, "ai", LATER);
    expect(switched.questions[0]?.mode).toBe("ai");
    expect(switched.questions[0]?.draft).toBe(application().questions[0]?.draft);
    expect(switched.questions[1]).toEqual(application().questions[1]);
    expect(switched.updatedAt).toBe(LATER);
    expect(validateApplication(switched).ok).toBe(true);
  });

  it("marks an edited AI answer as edited by the Candidate", () => {
    const edited = editAnswer(application(), 1, "My course planner serves 2,000 students.", LATER);
    expect(edited.questions[1]).toMatchObject({
      draft: "My course planner serves 2,000 students.",
      editedAt: LATER,
    });
    expect(validateApplication(edited).ok).toBe(true);
  });

  it("keeps the Candidate's own words under a brief, and clears them when emptied", () => {
    const written = writeOwnAnswer(
      application(),
      0,
      "  I sketch every idea in Acme first.  ",
      LATER,
    );
    expect(written.questions[0]?.own).toBe("I sketch every idea in Acme first.");
    const cleared = writeOwnAnswer(written, 0, "   ", LATER);
    expect(cleared.questions[0]).not.toHaveProperty("own");
  });
});

describe("final answers", () => {
  it("are the AI answer in AI mode and the Candidate's own words in brief mode", () => {
    const written = writeOwnAnswer(application(), 0, "I sketch every idea in Acme first.", LATER);
    expect(finalAnswers(written)).toEqual([
      {
        question: "Why do you want to join Acme?",
        mode: "brief",
        answer: "I sketch every idea in Acme first.",
        source: "candidate",
      },
      {
        question: "Tell us about a project you are proud of.",
        mode: "ai",
        answer: "I built a course planner that 2,000 students at my school use each term.",
        source: "ai",
      },
    ]);
  });

  it("leave an unwritten brief-mode answer blank, never the AI draft", () => {
    expect(finalAnswers(application())[0]).toEqual({
      question: "Why do you want to join Acme?",
      mode: "brief",
      answer: null,
      source: "none",
    });
  });

  it("say when the Candidate edited the AI answer", () => {
    const edited = editAnswer(application(), 1, "Edited.", LATER);
    expect(finalAnswers(edited)[1]).toMatchObject({ answer: "Edited.", source: "edited" });
  });
});

describe("recruiter search link", () => {
  it("is a LinkedIn people search the Candidate opens themselves", () => {
    expect(recruiterSearchUrl("Acme & Co")).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=Acme%20%26%20Co%20recruiter",
    );
  });
});
