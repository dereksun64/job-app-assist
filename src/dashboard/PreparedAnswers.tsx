/**
 * The Prepared Application sections of the detail drawer: each free-text question's answer, and
 * the Research Brief to write from. An answer is either AI-drafted (written to the Candidate's
 * Style Guide, marked as such, and editable) or the Candidate's own words under the brief; one
 * click switches a question between the two, and Fill types whichever the question is set to.
 * The page never calls Claude: Refresh and Fill prepare the answers, the page only edits them.
 */
import { ProblemText } from "./ProblemText.tsx";
import { useId, useState } from "preact/hooks";
import {
  editAnswer,
  recruiterSearchUrl,
  switchMode,
  writeOwnAnswer,
  type AnswerMode,
  type PreparedApplication,
  type PreparedQuestion,
  type QuestionType,
  type ResearchBrief,
} from "../contract/index.ts";
import { saveProblem } from "./saveProblem.ts";
import { formatDate } from "./format.ts";

/** Saves a change built at the given moment (an ISO timestamp); rejects when it is refused. */
export type SaveApplication = (change: (at: string) => PreparedApplication) => Promise<void>;

export interface ApplicationProps {
  /** The Posting's Prepared Application, or undefined while it has none. */
  doc: PreparedApplication | undefined;
  /** Null when this view has no database to save to. */
  save: SaveApplication | null;
}

const TYPE_LABELS: Record<QuestionType, string> = {
  why_company: "Why this company",
  why_role: "Why this role",
  about_you: "About you",
  experience: "Experience",
  project: "A project",
  challenge: "A challenge",
  cover_letter: "Cover letter",
  additional_info: "Anything else",
  other: "Open question",
};

const MODE_LABELS: Record<AnswerMode, string> = {
  ai: "AI draft",
  brief: "My own words",
};

export function PreparedAnswers({
  application,
  company,
}: {
  application: ApplicationProps;
  company: string;
}) {
  const headingId = useId();
  const { doc, save } = application;
  return (
    <section class="drawer-section" aria-labelledby={headingId}>
      <h3 class="drawer-heading" id={headingId}>
        Answers
      </h3>
      {doc === undefined ? (
        <p class="answers-intro">
          No answers yet. Your Claude prepares them on the next Refresh, or when it fills this
          Posting.
        </p>
      ) : doc.questions.length === 0 ? (
        <p class="answers-intro">
          This form has no free-text questions, so there is nothing to write.
        </p>
      ) : (
        <>
          <p class="answers-intro">
            Fill types these into {company}'s form. Edit any answer, or switch it to your own words.
          </p>
          <ol class="answers">
            {doc.questions.map((question, index) => (
              <li key={`${doc.postingId}-${question.question}`}>
                <Answer doc={doc} index={index} question={question} save={save} />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

type Status =
  { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

function Answer({
  doc,
  index,
  question,
  save,
}: {
  doc: PreparedApplication;
  index: number;
  question: PreparedQuestion;
  save: SaveApplication | null;
}) {
  const questionId = useId();
  const boxId = useId();
  const noteId = useId();
  // What the Candidate is typing in each box; null shows the saved text.
  const [draftEdit, setDraftEdit] = useState<string | null>(null);
  const [ownEdit, setOwnEdit] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const ai = question.mode === "ai";
  const saved = ai ? question.draft : (question.own ?? "");
  const edit = ai ? draftEdit : ownEdit;
  const value = edit ?? saved;
  const dirty = edit !== null && edit.trim() !== saved;
  const emptyAi = ai && value.trim() === "";
  const busy = status.kind === "saving";

  const run = (change: (at: string) => PreparedApplication, after?: () => void) => {
    if (!save) return;
    setStatus({ kind: "saving" });
    save(change).then(
      () => {
        after?.();
        setStatus({ kind: "saved" });
      },
      (error: unknown) => {
        setStatus({ kind: "failed", message: saveProblem(error) });
      },
    );
  };

  const setEdit = ai ? setDraftEdit : setOwnEdit;
  const onSave = () => {
    run(
      (at) => (ai ? editAnswer(doc, index, value, at) : writeOwnAnswer(doc, index, value, at)),
      () => {
        setEdit(null);
      },
    );
  };

  const mark = question.editedAt === undefined ? "AI-drafted" : "AI-drafted, edited by you";

  return (
    <article class="answer" aria-labelledby={questionId}>
      <header class="answer-header">
        <h4 class="answer-question" id={questionId}>
          {question.question}
        </h4>
        <span class="answer-type">{TYPE_LABELS[question.type]}</span>
      </header>

      <div class="answer-bar">
        <div class="answer-modes" role="group" aria-label="How to answer">
          {(["ai", "brief"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              class="answer-mode"
              aria-pressed={question.mode === mode}
              disabled={!save || busy}
              onClick={() => {
                if (mode !== question.mode) run((at) => switchMode(doc, index, mode, at));
              }}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        {ai && <span class="flag flag-ai">{mark}</span>}
      </div>

      {!ai && (
        <p class="answer-hint">
          Write this one yourself from the Research Brief below. Type it, or use your Mac's
          dictation.
        </p>
      )}
      <label class="visually-hidden" for={boxId}>
        {ai ? "AI-drafted answer" : "Your answer"}
      </label>
      <textarea
        id={boxId}
        class="answer-box"
        rows={ai ? 5 : 4}
        value={value}
        maxLength={question.maxLength}
        placeholder={ai ? undefined : "Your answer, in your own words"}
        readOnly={!save}
        aria-describedby={emptyAi ? noteId : undefined}
        onInput={(event) => {
          setEdit(event.currentTarget.value);
          if (status.kind !== "saving") setStatus({ kind: "idle" });
        }}
      />

      <div class="answer-footer">
        {question.maxLength !== undefined && (
          <span class="answer-count numeric">
            {value.length.toLocaleString("en-US")} of {question.maxLength.toLocaleString("en-US")}{" "}
            characters
          </span>
        )}
        {dirty && (
          <span class="answer-actions">
            <button type="button" class="answer-save" disabled={busy || emptyAi} onClick={onSave}>
              Save answer
            </button>
            <button
              type="button"
              class="answer-discard"
              disabled={busy}
              onClick={() => {
                setEdit(null);
                setStatus({ kind: "idle" });
              }}
            >
              Discard
            </button>
          </span>
        )}
        <span class="answer-status" role="status">
          {status.kind === "saving" ? "Saving…" : status.kind === "saved" ? "Saved" : ""}
        </span>
      </div>

      {emptyAi && (
        <p class="answer-note" id={noteId}>
          An AI-drafted answer can't be empty. Switch to My own words to leave it for yourself.
        </p>
      )}
      {!ai && saved === "" && (edit ?? "").trim() === "" && (
        <p class="answer-note">Until you write it, Fill leaves this question blank and flags it.</p>
      )}
      {status.kind === "failed" && (
        <p class="answer-error" role="alert">
          <ProblemText text={status.message} />
        </p>
      )}
    </article>
  );
}

export function ResearchBriefSection({
  brief,
  company,
  now,
}: {
  brief: ResearchBrief;
  company: string;
  now: number;
}) {
  const headingId = useId();
  return (
    <section class="drawer-section" aria-labelledby={headingId}>
      <h3 class="drawer-heading" id={headingId}>
        Research Brief
      </h3>
      <dl class="brief">
        <div class="brief-item">
          <dt>What {company} does</dt>
          <dd>{brief.company}</dd>
        </div>
        <div class="brief-item">
          <dt>Recent news</dt>
          <dd>
            {brief.news.length === 0 ? (
              <span class="muted">No recent news turned up.</span>
            ) : (
              <ul class="brief-news">
                {brief.news.map((item) => (
                  <li key={item.url}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.headline}
                      <span aria-hidden="true"> ↗</span>
                    </a>
                    <span class="brief-source">
                      {item.publishedOn
                        ? `${item.source}, ${formatDate(item.publishedOn, now)}`
                        : item.source}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div class="brief-item">
          <dt>The team</dt>
          <dd>{brief.team}</dd>
        </div>
        <div class="brief-item">
          <dt>How you fit</dt>
          <dd>{brief.fit}</dd>
        </div>
      </dl>
      <a
        class="referral-search"
        href={recruiterSearchUrl(company)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Find {company} recruiters on LinkedIn<span aria-hidden="true"> ↗</span>
      </a>
    </section>
  );
}
