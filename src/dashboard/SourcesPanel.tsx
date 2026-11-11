import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ProblemText } from "./ProblemText.tsx";
import {
  ADDED_BY_URL_SOURCE,
  ADDED_BY_URL_SOURCE_ID,
  JOB_BOARD_NAMES,
  JOB_FEED_SOURCE,
  JOB_FEED_SOURCE_ID,
  WATCHLIST_SOURCE,
  WATCHLIST_SOURCE_ID,
  canonicalApplyUrl,
  jobBoardFromUrl,
  jobBoardUrl,
  type AddedPosting,
  type JobListMeta,
  type Posting,
  type SourceId,
  type SourceReport,
  type SourceSettings,
  type WatchedCompany,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";
import type { JobListState } from "./useJobList.ts";
import { saveSource, type SourcesState } from "./useSources.ts";

export interface SourcesPanelProps {
  db: DashboardDb | null | undefined;
  state: SourcesState;
  jobList: JobListState;
  now: number;
  onClose: () => void;
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "palantir" reads as "Palantir", "scale-ai" as "Scale Ai": a starting point the Candidate can change. */
function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The link as a web address, adding https:// when the Candidate left it off. */
function webAddress(text: string): string | undefined {
  const trimmed = text.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(withScheme) ? withScheme : undefined;
}

/** What the last Refresh said about the Sources, for the status lines. */
interface LastRefresh {
  meta: JobListMeta;
  postings: readonly Posting[];
}

function lastRefreshOf(jobList: JobListState): LastRefresh | undefined {
  return jobList.kind === "ready" ? { meta: jobList.meta, postings: jobList.postings } : undefined;
}

function reportFor(last: LastRefresh | undefined, name: string, list?: string) {
  return last?.meta.sources.find((report) => report.name === name && report.list === list);
}

/**
 * The Sources panel: an on/off switch per Source, the watchlist editor and the Add by URL box.
 * It writes only the sources collection; Refresh picks the changes up next time it runs.
 */
export function SourcesPanel({ db, state, jobList, now, onClose }: SourcesPanelProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState<SourceId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const last = lastRefreshOf(jobList);
  const ready = state.kind === "ready" && db ? { db, sources: state.sources } : undefined;

  /** Saves one Source with `change` applied; resolves true when it was saved. */
  const save = async (
    id: SourceId,
    change: (sources: SourceSettings) => SourceSettings,
  ): Promise<boolean> => {
    if (!ready) return false;
    setSaving(id);
    setProblem(null);
    const failed = await saveSource(
      ready.db,
      id,
      change(ready.sources),
      new Date(now).toISOString(),
    );
    setSaving(null);
    setProblem(failed ?? null);
    return failed === undefined;
  };

  return (
    <dialog
      ref={dialog}
      class="sheet"
      aria-labelledby="sources-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div class="sheet-body">
        <header class="sheet-header">
          <h2 id="sources-title">Sources</h2>
          <button
            type="button"
            class="icon-button"
            aria-label="Close"
            onClick={() => dialog.current?.close()}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.75" />
            </svg>
          </button>
        </header>
        <p class="sheet-intro">
          Refresh reads the Sources you switch on. Changes here apply on your next Refresh.
        </p>

        {state.kind === "loading" && (
          <p class="notice notice-quiet" role="status">
            Loading your Sources…
          </p>
        )}
        {(state.kind === "failed" || state.kind === "unavailable") && (
          <p class="notice notice-problem" role="alert">
            Your Sources can't be loaded right now. Reload the page to try again.
          </p>
        )}
        {state.kind === "ready" && state.issues.length > 0 && (
          <div class="notice notice-problem" role="alert">
            <p>
              Your Sources don't match what this dashboard expects, so Refresh skips the ones below
              until they are saved again from this panel.
            </p>
            <ul class="issues">
              {state.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
        {problem && (
          <p class="notice notice-problem" role="alert">
            <ProblemText text={problem} />
          </p>
        )}

        {state.kind === "ready" && (
          <>
            <JobFeedSection
              enabled={state.sources.jobFeed.enabled}
              report={reportFor(last, JOB_FEED_SOURCE)}
              busy={saving !== null}
              onToggle={(enabled) =>
                void save(JOB_FEED_SOURCE_ID, (s) => ({ ...s, jobFeed: { enabled } }))
              }
            />
            <WatchlistSection
              watchlist={state.sources.watchlist}
              last={last}
              busy={saving !== null}
              onToggle={(enabled) =>
                void save(WATCHLIST_SOURCE_ID, (s) => ({
                  ...s,
                  watchlist: { ...s.watchlist, enabled },
                }))
              }
              onChange={(companies) =>
                save(WATCHLIST_SOURCE_ID, (s) => ({
                  ...s,
                  watchlist: { ...s.watchlist, companies },
                }))
              }
            />
            <AddByUrlSection
              addedByUrl={state.sources.addedByUrl}
              last={last}
              busy={saving !== null}
              now={now}
              onToggle={(enabled) =>
                void save(ADDED_BY_URL_SOURCE_ID, (s) => ({
                  ...s,
                  addedByUrl: { ...s.addedByUrl, enabled },
                }))
              }
              onChange={(postings) =>
                save(ADDED_BY_URL_SOURCE_ID, (s) => ({
                  ...s,
                  addedByUrl: { ...s.addedByUrl, postings },
                }))
              }
            />
          </>
        )}
      </div>
    </dialog>
  );
}

function Switch({
  labelledBy,
  checked,
  disabled,
  onChange,
}: {
  labelledBy: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span class="switch-thumb" aria-hidden="true" />
    </button>
  );
}

function SourceSection({
  id,
  title,
  enabled,
  busy,
  onToggle,
  about,
  status,
  children,
}: {
  id: string;
  title: string;
  enabled: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  about: string;
  status: string;
  children?: preact.ComponentChildren;
}) {
  const headingId = `source-${id}`;
  return (
    <section class={enabled ? "source" : "source source-off"} aria-labelledby={headingId}>
      <div class="source-head">
        <h3 id={headingId}>{title}</h3>
        <Switch labelledBy={headingId} checked={enabled} disabled={busy} onChange={onToggle} />
      </div>
      <p class="source-about">{about}</p>
      <p class="source-status">{status}</p>
      {children}
    </section>
  );
}

function JobFeedSection({
  enabled,
  report,
  busy,
  onToggle,
}: {
  enabled: boolean;
  report: SourceReport | undefined;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const status = !enabled
    ? "Off. Your next Refresh skips the Job Feed."
    : report === undefined
      ? "On. Your next Refresh reads it."
      : report.ok
        ? `On. The last Refresh read ${count(report.postings, "Posting")} from it.`
        : `On, but the last Refresh couldn't read it. ${report.error ?? ""}`.trim();
  return (
    <SourceSection
      id={JOB_FEED_SOURCE_ID}
      title={JOB_FEED_SOURCE}
      enabled={enabled}
      busy={busy}
      onToggle={onToggle}
      about="The shared list of entry-level Postings every Candidate starts with, gathered from many curated job lists."
      status={status}
    />
  );
}

function companyStatus(
  company: WatchedCompany,
  last: LastRefresh | undefined,
): { text: string; problem: boolean } {
  const report = reportFor(last, WATCHLIST_SOURCE, company.name);
  if (!last || !report) return { text: "Read on your next Refresh", problem: false };
  if (!report.ok) {
    const text = `The last Refresh couldn't read this board. ${report.error ?? ""}`.trim();
    return { text, problem: true };
  }
  const inList = last.postings.filter((posting) =>
    posting.sources.some((s) => s.name === WATCHLIST_SOURCE && s.list === company.name),
  ).length;
  const text = `${count(report.postings, "open job")}, ${inList.toLocaleString("en-US")} in your Job List`;
  return { text, problem: false };
}

function CompanyStatus({ status }: { status: { text: string; problem: boolean } }) {
  return (
    <p class={status.problem ? "source-item-status source-item-problem" : "source-item-status"}>
      {status.text}
    </p>
  );
}

function WatchlistSection({
  watchlist,
  last,
  busy,
  onToggle,
  onChange,
}: {
  watchlist: SourceSettings["watchlist"];
  last: LastRefresh | undefined;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onChange: (companies: WatchedCompany[]) => Promise<boolean>;
}) {
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const board = useMemo(() => jobBoardFromUrl(link), [link]);
  const suggested = board ? nameFromSlug(board.slug) : "";

  const add = async () => {
    if (!board) {
      setError(
        "Paste a link to the company's job board on Greenhouse, Lever or Ashby, such as https://jobs.lever.co/palantir.",
      );
      return;
    }
    const existing = watchlist.companies.find(
      (c) => c.board === board.board && c.slug.toLowerCase() === board.slug.toLowerCase(),
    );
    if (existing) {
      setError(`${existing.name} is already on your watchlist.`);
      return;
    }
    setError(null);
    const company: WatchedCompany = { name: name.trim() || suggested, ...board };
    if (await onChange([...watchlist.companies, company])) {
      setLink("");
      setName("");
    }
  };

  const status = !watchlist.enabled
    ? "Off. Your next Refresh skips your watchlist."
    : watchlist.companies.length === 0
      ? "On. Add a company below to read its job board on every Refresh."
      : `On. Your next Refresh reads ${count(watchlist.companies.length, "job board")}.`;

  return (
    <SourceSection
      id={WATCHLIST_SOURCE_ID}
      title={WATCHLIST_SOURCE}
      enabled={watchlist.enabled}
      busy={busy}
      onToggle={onToggle}
      about="Companies read straight from their public Greenhouse, Lever or Ashby job board, so you see their Postings before curated lists do."
      status={status}
    >
      {watchlist.companies.length === 0 ? (
        <p class="source-empty">No companies on your watchlist yet.</p>
      ) : (
        <ul class="source-items" aria-label="Companies on your watchlist">
          {watchlist.companies.map((company) => (
            <li key={`${company.board}/${company.slug}`} class="source-item">
              <div class="source-item-main">
                <h4>{company.name}</h4>
                <p class="source-item-meta">
                  <a href={jobBoardUrl(company)} target="_blank" rel="noopener noreferrer">
                    {JOB_BOARD_NAMES[company.board]}: {company.slug}
                  </a>
                </p>
                <CompanyStatus status={companyStatus(company, last)} />
              </div>
              <button
                type="button"
                class="link-button"
                aria-label={`Remove ${company.name}`}
                disabled={busy}
                onClick={() => {
                  void onChange(watchlist.companies.filter((c) => c !== company));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        class="source-form source-form-watchlist"
        aria-label="Add a company to your watchlist"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field
          id="watchlist-link"
          label="Job board link"
          value={link}
          placeholder="https://jobs.lever.co/palantir"
          wide
          invalid={error !== null}
          describedBy={error ? "watchlist-error" : undefined}
          onInput={(value) => {
            setLink(value);
            setError(null);
          }}
        />
        <Field
          id="watchlist-name"
          label="Company"
          value={name}
          placeholder={suggested || "From the link"}
          onInput={setName}
        />
        <button type="submit" class="button" disabled={busy}>
          Add company
        </button>
        {error && (
          <p class="field-error" id="watchlist-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </SourceSection>
  );
}

function addedStatus(posting: AddedPosting, last: LastRefresh | undefined): string {
  const url = canonicalApplyUrl(posting.url);
  if (last?.postings.some((p) => p.applyUrl === url)) return "In your Job List";
  const read = last && reportFor(last, ADDED_BY_URL_SOURCE);
  if (!last || !read || posting.addedAt > last.meta.refreshedAt) {
    return "Joins your Job List on the next Refresh";
  }
  return "Not in your Job List: it doesn't match your Search Profile.";
}

const DETAIL_LABELS = { company: "the company", title: "the title", location: "the location" };

function AddByUrlSection({
  addedByUrl,
  last,
  busy,
  now,
  onToggle,
  onChange,
}: {
  addedByUrl: SourceSettings["addedByUrl"];
  last: LastRefresh | undefined;
  busy: boolean;
  now: number;
  onToggle: (enabled: boolean) => void;
  onChange: (postings: AddedPosting[]) => Promise<boolean>;
}) {
  const empty = { link: "", company: "", title: "", location: "" };
  const [fields, setFields] = useState(empty);
  const [error, setError] = useState<{ message: string; fields: string[] } | null>(null);
  const board = useMemo(() => jobBoardFromUrl(fields.link), [fields.link]);
  const suggestedCompany = board ? nameFromSlug(board.slug) : "";

  const set = (name: keyof typeof empty) => (value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    setError(null);
  };

  const add = async () => {
    const url = webAddress(fields.link);
    if (!url) {
      setError({
        message: "Paste the Posting's full link, starting with https://.",
        fields: ["link"],
      });
      return;
    }
    const details = {
      company: fields.company.trim() || suggestedCompany,
      title: fields.title.trim(),
      location: fields.location.trim(),
    };
    const missing = (Object.keys(details) as (keyof typeof details)[]).filter(
      (key) => details[key] === "",
    );
    if (missing.length > 0) {
      const names = missing.map((key) => DETAIL_LABELS[key]);
      const list =
        names.length === 1
          ? names[0]
          : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
      setError({
        message: `Add ${list ?? ""}, so Refresh can rank this Posting.`,
        fields: missing,
      });
      return;
    }
    const canonical = canonicalApplyUrl(url);
    if (addedByUrl.postings.some((p) => canonicalApplyUrl(p.url) === canonical)) {
      setError({ message: "You already added this Posting.", fields: ["link"] });
      return;
    }
    setError(null);
    const posting: AddedPosting = { url, ...details, addedAt: new Date(now).toISOString() };
    if (await onChange([...addedByUrl.postings, posting])) setFields(empty);
  };

  const invalid = (name: string) => error?.fields.includes(name) ?? false;
  const status = !addedByUrl.enabled
    ? "Off. Your next Refresh leaves out the Postings you added."
    : addedByUrl.postings.length === 0
      ? "On. Paste a Posting's link below to add it to your Job List."
      : `On. ${count(addedByUrl.postings.length, "Posting")} added.`;

  return (
    <SourceSection
      id={ADDED_BY_URL_SOURCE_ID}
      title="Add by URL"
      enabled={addedByUrl.enabled}
      busy={busy}
      onToggle={onToggle}
      about="Paste the link of any Posting you found elsewhere, including on Runway or LinkedIn. It joins your Job List on the next Refresh when it matches your Search Profile."
      status={status}
    >
      {addedByUrl.postings.length === 0 ? (
        <p class="source-empty">Nothing added yet.</p>
      ) : (
        <ul class="source-items" aria-label="Postings you added">
          {addedByUrl.postings.map((posting) => (
            <li key={posting.url} class="source-item">
              <div class="source-item-main">
                <h4>
                  <a href={posting.url} target="_blank" rel="noopener noreferrer">
                    {posting.title}
                  </a>
                </h4>
                <p class="source-item-meta">
                  {posting.company} · {posting.location}
                </p>
                <p class="source-item-status">{addedStatus(posting, last)}</p>
              </div>
              <button
                type="button"
                class="link-button"
                aria-label={`Remove ${posting.title} at ${posting.company}`}
                disabled={busy}
                onClick={() => {
                  void onChange(addedByUrl.postings.filter((p) => p !== posting));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        class="source-form source-form-added"
        aria-label="Add a Posting by URL"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field
          id="added-link"
          label="Posting link"
          value={fields.link}
          placeholder="https://"
          wide
          invalid={invalid("link")}
          describedBy={error ? "added-error" : undefined}
          onInput={set("link")}
        />
        <Field
          id="added-company"
          label="Company"
          value={fields.company}
          placeholder={suggestedCompany || "Acme"}
          invalid={invalid("company")}
          describedBy={error ? "added-error" : undefined}
          onInput={set("company")}
        />
        <Field
          id="added-title"
          label="Title"
          value={fields.title}
          placeholder="Software Engineer, New Grad"
          invalid={invalid("title")}
          describedBy={error ? "added-error" : undefined}
          onInput={set("title")}
        />
        <Field
          id="added-location"
          label="Location"
          value={fields.location}
          placeholder="New York, NY or Remote"
          invalid={invalid("location")}
          describedBy={error ? "added-error" : undefined}
          onInput={set("location")}
        />
        <button type="submit" class="button" disabled={busy}>
          Add Posting
        </button>
        {error && (
          <p class="field-error" id="added-error" role="alert">
            {error.message}
          </p>
        )}
      </form>
    </SourceSection>
  );
}

function Field({
  id,
  label,
  value,
  placeholder,
  wide = false,
  invalid = false,
  describedBy,
  onInput,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  wide?: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  onInput: (value: string) => void;
}) {
  return (
    <div class={wide ? "field field-wide" : "field"}>
      <label class="field-label" for={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        autocomplete="off"
        spellcheck={false}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onInput={(event) => {
          onInput(event.currentTarget.value);
        }}
      />
    </div>
  );
}
