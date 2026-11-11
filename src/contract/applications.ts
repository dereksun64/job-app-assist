import * as z from "zod/mini";
import { postingIdSchema, timestampSchema } from "./postings.ts";
import { validateWith, type Validation } from "./validation.ts";

/**
 * The applications collection holds one Prepared Application per queued Posting, stored under
 * the Posting's id: an answer to each free-text question on its form, and a Research Brief to
 * write from. Refresh or Fill creates it and never changes it afterwards; from then on only the
 * Candidate changes it, in the detail drawer (editing an answer, switching its mode, writing
 * their own words under the brief). Fill types the final answers into the form.
 *
 * Each question is in one of two modes. In `ai` mode the form gets the AI-drafted answer,
 * written to the Candidate's Style Guide (or the Candidate's edit of it). In `brief` mode the
 * form gets only what the Candidate wrote themselves, so an unwritten brief-mode answer stays
 * blank and is flagged. Both texts are kept, so switching back and forth loses nothing.
 *
 * Only free-text answers live here. The standard and sensitive answers a form asks for (name,
 * address, work authorization, demographics) stay in the private file in the Candidate folder,
 * and the strict shapes below leave no room for them.
 */
export const APPLICATIONS_COLLECTION = "applications";

/** What a free-text question asks about; its type picks the answer's default mode. */
export const QUESTION_TYPES = [
  "why_company",
  "why_role",
  "about_you",
  "experience",
  "project",
  "challenge",
  "cover_letter",
  "additional_info",
  "other",
] as const;

/** `ai`: Fill types the AI-drafted answer. `brief`: the Candidate writes it from the brief. */
export const ANSWER_MODES = ["ai", "brief"] as const;

/** Who prepared the application: Refresh for a pre-queued Posting, or Fill from the form. */
export const PREPARED_BY = ["refresh", "fill"] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type AnswerMode = (typeof ANSWER_MODES)[number];

/**
 * Questions about why this company or this role get a Research Brief: an AI answer to them
 * reads as generic, and they are where the Candidate's own words count most.
 */
const BRIEF_TYPES: ReadonlySet<QuestionType> = new Set(["why_company", "why_role"]);

export function defaultMode(type: QuestionType): AnswerMode {
  return BRIEF_TYPES.has(type) ? "brief" : "ai";
}

/** The most free-text questions one form gets answers for. */
export const MAX_QUESTIONS = 20;

/** The longest answer: room for a cover letter. */
export const ANSWER_MAX = 5000;

/** The most news items a Research Brief links. */
export const MAX_BRIEF_NEWS = 3;

const text = (max: number) =>
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "must not be blank"),
      z.maxLength(max, `must be ${String(max)} characters or fewer`),
    );

const httpsUrl = z.string().check(
  z.maxLength(2000, "must be 2000 characters or fewer"),
  z.refine((value) => URL.canParse(value) && new URL(value).protocol === "https:", {
    message: "must be an https URL",
  }),
);

const question = z
  .strictObject({
    /** The question as the form words it. */
    question: text(500),
    type: z.enum(QUESTION_TYPES),
    mode: z.enum(ANSWER_MODES),
    /** The AI-mode answer: drafted to the Style Guide, or the Candidate's edit of the draft. */
    draft: text(ANSWER_MAX),
    /** When the Candidate last edited the AI-drafted answer; absent while it is all AI text. */
    editedAt: z.optional(timestampSchema),
    /** The Candidate's own answer, written under the Research Brief. */
    own: z.optional(text(ANSWER_MAX)),
    /** The form's character limit for the answer, when it shows one. */
    maxLength: z.optional(z.int().check(z.minimum(1), z.maximum(ANSWER_MAX))),
  })
  .check(
    z.superRefine((value, ctx) => {
      if (value.maxLength === undefined) return;
      for (const key of ["draft", "own"] as const) {
        const answer = value[key];
        if (answer !== undefined && answer.length > value.maxLength) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `must be ${String(value.maxLength)} characters or fewer, the form's limit`,
            input: answer,
          });
        }
      }
    }),
  );

const newsItem = z.strictObject({
  headline: text(200),
  url: httpsUrl,
  /** The publisher, such as Reuters. */
  source: text(80),
  publishedOn: z.optional(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"))),
});

/**
 * Notes on one company and role for the Candidate to write from. The LinkedIn recruiter search
 * is not stored: the page builds it from the company name (see `recruiterSearchUrl`), so the
 * only LinkedIn link is a search the Candidate opens themselves.
 */
const brief = z.strictObject({
  /** What the company does, in a sentence or two. */
  company: text(600),
  /** Recent news about the company, each linking its source. */
  news: z
    .array(newsItem)
    .check(z.maxLength(MAX_BRIEF_NEWS, `must link at most ${String(MAX_BRIEF_NEWS)}`)),
  /** What is known about the team the role sits on. */
  team: text(600),
  /** How the role fits the Candidate's background, from their resume. */
  fit: text(800),
});

const application = z
  .strictObject({
    schemaVersion: z.literal(1),
    postingId: postingIdSchema,
    preparedAt: timestampSchema,
    preparedBy: z.enum(PREPARED_BY),
    questions: z.array(question).check(
      z.maxLength(MAX_QUESTIONS, `must hold at most ${String(MAX_QUESTIONS)}`),
      z.superRefine((questions, ctx) => {
        const seen = new Set<string>();
        for (const { question: wording } of questions) {
          const key = wording.trim().toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({
              code: "custom",
              message: `"${wording}" is listed more than once`,
              input: wording,
            });
          }
          seen.add(key);
        }
      }),
    ),
    /** Present whenever there is a question, so any answer can switch to brief mode. */
    brief: z.optional(brief),
    updatedAt: timestampSchema,
  })
  .check(
    z.superRefine((value, ctx) => {
      if (value.questions.length > 0 && value.brief === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["brief"],
          message: "questions need a Research Brief, so any answer can switch to brief mode",
          input: value.brief,
        });
      }
    }),
  );

export type PreparedQuestion = z.output<typeof question>;
export type ResearchBrief = z.output<typeof brief>;
export type BriefNews = z.output<typeof newsItem>;
export type PreparedApplication = z.output<typeof application>;

export function validateApplication(input: unknown): Validation<PreparedApplication> {
  return validateWith(application, input);
}

/** Validates a document in the applications collection, which sits under its Posting's id. */
export function validateApplicationDocument(
  docId: string,
  input: unknown,
): Validation<PreparedApplication> {
  const result = validateApplication(input);
  if (result.ok && result.value.postingId !== docId) {
    return {
      ok: false,
      issues: [
        `A Prepared Application is stored under its Posting's id: ${APPLICATIONS_COLLECTION}/${result.value.postingId}, not ${APPLICATIONS_COLLECTION}/${docId}.`,
      ],
    };
  }
  return result;
}

function changeQuestion(
  from: PreparedApplication,
  index: number,
  at: string,
  change: (q: PreparedQuestion) => PreparedQuestion,
): PreparedApplication {
  const current = from.questions[index];
  if (current === undefined) throw new RangeError(`There is no question ${String(index + 1)}.`);
  const questions = from.questions.slice();
  questions[index] = change(current);
  return { ...from, questions, updatedAt: at };
}

/** The application with one question switched to `mode`; both answers are kept. */
export function switchMode(
  from: PreparedApplication,
  index: number,
  mode: AnswerMode,
  at: string,
): PreparedApplication {
  return changeQuestion(from, index, at, (q) => ({ ...q, mode }));
}

/** The application with the Candidate's edit of one AI-drafted answer. */
export function editAnswer(
  from: PreparedApplication,
  index: number,
  answer: string,
  at: string,
): PreparedApplication {
  return changeQuestion(from, index, at, (q) => ({ ...q, draft: answer.trim(), editedAt: at }));
}

/** The application with the Candidate's own answer to one question; blank removes it. */
export function writeOwnAnswer(
  from: PreparedApplication,
  index: number,
  answer: string,
  at: string,
): PreparedApplication {
  return changeQuestion(from, index, at, (q) => {
    const next: PreparedQuestion = { ...q };
    const own = answer.trim();
    if (own === "") delete next.own;
    else next.own = own;
    return next;
  });
}

/**
 * What Fill types for one question. `answer` is null when the question is in brief mode and the
 * Candidate has not written it yet: Fill leaves that field blank and flags it.
 * `source` says whose words they are: all AI, AI edited by the Candidate, or the Candidate's own.
 */
export interface FinalAnswer {
  question: string;
  mode: AnswerMode;
  answer: string | null;
  source: "ai" | "edited" | "candidate" | "none";
}

export function finalAnswers(of: PreparedApplication): FinalAnswer[] {
  return of.questions.map((q) => {
    if (q.mode === "ai") {
      return {
        question: q.question,
        mode: q.mode,
        answer: q.draft,
        source: q.editedAt === undefined ? "ai" : "edited",
      };
    }
    return q.own === undefined
      ? { question: q.question, mode: q.mode, answer: null, source: "none" }
      : { question: q.question, mode: q.mode, answer: q.own, source: "candidate" };
  });
}

/**
 * A LinkedIn people search for the company's recruiters. The Candidate opens it themselves;
 * the Toolkit never opens, reads or automates LinkedIn.
 */
export function recruiterSearchUrl(company: string): string {
  const keywords = encodeURIComponent(`${company} recruiter`.replace(/\s+/g, " ").trim());
  return `https://www.linkedin.com/search/results/people/?keywords=${keywords}`;
}
