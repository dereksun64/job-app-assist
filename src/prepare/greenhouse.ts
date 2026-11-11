/**
 * Reading a form's free-text questions ahead of Fill, without opening the form. Greenhouse's
 * public job board API lists every question on a job's application form; other sites have no
 * such API, so their Postings are prepared by Fill from the live form instead.
 */
import type { Fetch } from "../refresh/job-feed.ts";
import { decode, plain } from "../refresh/forums.ts";

const TIMEOUT_MS = 20_000;

/** The longest job description excerpt handed to the drafting Claude. */
export const DESCRIPTION_MAX = 3000;

/** Greenhouse's own text boxes for pasting a resume or cover letter, which Fill never fills. */
const PASTE_FIELDS = new Set(["resume_text", "cover_letter_text"]);

const HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);

export interface GreenhouseJob {
  board: string;
  job: string;
}

/** The Greenhouse board and job an apply URL is on, or undefined for any other site. */
export function greenhouseJob(applyUrl: string): GreenhouseJob | undefined {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return undefined;
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const path = /^\/([^/]+)\/jobs\/(\d+)/.exec(url.pathname);
  if (path?.[1] && path[2] && path[1] !== "embed") return { board: path[1], job: path[2] };
  const board = url.searchParams.get("for");
  const job = url.searchParams.get("token");
  if (url.pathname.startsWith("/embed/") && board && job && /^\d+$/.test(job)) {
    return { board, job };
  }
  return undefined;
}

export interface FormQuestion {
  /** The question as the form words it. */
  question: string;
  required: boolean;
}

export type FormQuestions =
  | { kind: "read"; questions: FormQuestion[]; description?: string }
  | { kind: "unsupported" }
  | { kind: "failed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

function excerpt(content: string): string | undefined {
  const body = plain(decode(content));
  if (body === "") return undefined;
  return body.length <= DESCRIPTION_MAX ? body : `${body.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

/**
 * The free-text questions on the form behind `applyUrl`, read ahead of Fill when the site
 * allows it. A free-text question is a text area the Candidate writes into, leaving out the
 * boxes for pasting a resume or cover letter.
 */
export async function readFormQuestions(applyUrl: string, fetch: Fetch): Promise<FormQuestions> {
  const job = greenhouseJob(applyUrl);
  if (job === undefined) return { kind: "unsupported" };
  const api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(job.board)}/jobs/${job.job}?questions=true`;
  let json: unknown;
  try {
    const response = await fetch(api, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok)
      return { kind: "failed", reason: `Greenhouse answered ${String(response.status)}` };
    json = await response.json();
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecord(json) || !Array.isArray(json.questions)) {
    return { kind: "failed", reason: "Greenhouse sent no questions" };
  }
  const questions: FormQuestion[] = [];
  for (const item of json.questions) {
    if (!isRecord(item) || !Array.isArray(item.fields)) continue;
    const freeText = item.fields.some(
      (field) =>
        isRecord(field) && field.type === "textarea" && !PASTE_FIELDS.has(text(field.name)),
    );
    const question = text(item.label);
    if (freeText && question !== "") questions.push({ question, required: item.required === true });
  }
  const description = excerpt(typeof json.content === "string" ? json.content : "");
  return description === undefined
    ? { kind: "read", questions }
    : { kind: "read", questions, description };
}
