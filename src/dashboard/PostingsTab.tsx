import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ProblemText } from "./ProblemText.tsx";
import {
  JOB_FEED_SOURCE,
  WATCHLIST_SOURCE,
  POSSIBLY_CLOSED_DAYS,
  SKIP_REASONS,
  chosenVariant,
  queueAgeDays,
  type Card,
  type ChosenVariant,
  type JobListMeta,
  type Posting,
  type PreparedApplication,
  type Skip,
  type SkipReason,
  type Referrals,
  type VariantOverride,
} from "../contract/index.ts";
import {
  CLOSED_REASON_LABELS,
  SKIP_REASON_LABELS,
  STAGE_LABELS,
  count,
  daysSincePosted,
  formatLevel,
  formatMoment,
  formatPostedAge,
} from "./format.ts";
import { PostingDrawer } from "./PostingDrawer.tsx";
import type { SaveApplication } from "./PreparedAnswers.tsx";
import type { JobListState } from "./useJobList.ts";
import { saveProblem } from "./saveProblem.ts";
import type { QueueActions, QueueState } from "./useQueue.ts";

/** How many Postings the list shows at first, and adds per "Show more". */
export const PAGE_SIZE = 100;

const POSTED_WINDOWS = [
  { value: "", label: "Any time" },
  { value: "1", label: "Past day" },
  { value: "3", label: "Past 3 days" },
  { value: "7", label: "Past week" },
  { value: "14", label: "Past 2 weeks" },
  { value: "30", label: "Past month" },
] as const;

const SHOW_OPTIONS = [
  { value: "all", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "skipped", label: "Skipped" },
] as const;
type Show = (typeof SHOW_OPTIONS)[number]["value"];

interface Filters {
  show: Show;
  text: string;
  roleType: string;
  tier: string;
  source: string;
  posted: string;
}

const NO_FILTERS: Filters = {
  show: "all",
  text: "",
  roleType: "",
  tier: "",
  source: "",
  posted: "",
};
const LIST_SEPARATOR = "\u0000";

/** What the Postings tab needs to show and change each Posting's Resume Variant. */
export interface ResumeVariantProps {
  /** The names of the Candidate's Resume Variants, in their order. */
  resumeVariants: readonly string[];
  /** The Candidate's own choices, by Posting id. */
  overrides: ReadonlyMap<string, VariantOverride>;
  onChooseVariant: (posting: Posting, variant: string) => Promise<void>;
  /** The Referral Drafts Refresh wrote, by Posting id. */
  referrals: ReadonlyMap<string, Referrals>;
  /** The Prepared Applications, by Posting id. */
  applications: ReadonlyMap<string, PreparedApplication>;
  /** Saves the Candidate's change to a Prepared Application; null without a database. */
  onSaveApplication: SaveApplication | null;
}

export interface PostingsTabProps extends ResumeVariantProps {
  state: JobListState;
  queue: QueueState;
  /** Null when this view has no database to save Queue changes to. */
  actions: QueueActions | null;
  /** The settings' daily Queue target, once settings have loaded. */
  dailyQueueTarget: number | undefined;
  /** The Search Profile's role types, in the Candidate's order, for the role type filter. */
  roleTypeOrder: readonly string[];
  now: number;
}

export function PostingsTab({
  state,
  queue,
  actions,
  dailyQueueTarget,
  roleTypeOrder,
  now,
  ...variants
}: PostingsTabProps) {
  switch (state.kind) {
    case "loading":
    case "unavailable":
      return null;
    case "failed":
      return (
        <p class="notice notice-problem" role="alert">
          Your Job List stopped loading. Reload the page to try again.
        </p>
      );
    case "invalid":
      return (
        <div class="notice notice-problem" role="alert">
          <p>
            Your Job List doesn't match what this dashboard expects. Ask your Claude to refresh
            again to rebuild it.
          </p>
          <ul class="issues">
            {state.issues.slice(0, 5).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      );
    case "writing":
      return (
        <p class="notice notice-quiet" role="status">
          Refresh is writing your Job List. It will appear here in a moment.
        </p>
      );
    case "empty":
      return (
        <div class="empty">
          <h2>Your Job List is empty</h2>
          <p>
            Refresh pulls Postings from your Sources, keeps the ones that match your Search Profile,
            and ranks them best first. Ask your Claude to refresh.
          </p>
        </div>
      );
    case "ready":
      return (
        <JobList
          meta={state.meta}
          postings={state.postings}
          updating={state.updating}
          queue={queue}
          actions={actions}
          dailyQueueTarget={dailyQueueTarget}
          roleTypeOrder={roleTypeOrder}
          now={now}
          {...variants}
        />
      );
  }
}

/** A Source, or the part of one a report covers, as it reads inside a sentence. */
function sourceLabel({ name, list }: Pick<JobListMeta["sources"][number], "name" | "list">) {
  if (name === WATCHLIST_SOURCE && list) return `${list}'s job board`;
  return name === JOB_FEED_SOURCE ? "the Job Feed" : list ? `${list} in ${name}` : name;
}

function SourceProblems({ meta }: { meta: JobListMeta }) {
  const failing = meta.sources.filter((source) => !source.ok);
  if (failing.length === 0) return null;
  return (
    <div class="notice notice-problem" role="alert">
      {failing.map((source) => (
        <p key={`${source.name}\u0000${source.list ?? ""}`}>
          {`Your Job List may be incomplete. The last Refresh couldn't read ${sourceLabel(source)}, so it kept the Postings found there before.`}
          {source.error ? ` ${source.error}` : ""}
        </p>
      ))}
    </div>
  );
}

interface JobListProps extends ResumeVariantProps {
  meta: JobListMeta;
  postings: readonly Posting[];
  updating: boolean;
  queue: QueueState;
  actions: QueueActions | null;
  dailyQueueTarget: number | undefined;
  roleTypeOrder: readonly string[];
  now: number;
}

/** One row of the list: a Posting with its rank, card and skip. */
interface Entry {
  posting: Posting;
  /** Its place in the Job List; absent for a queued Posting that has left the Job List. */
  rank: number | undefined;
  card: Card | undefined;
  skip: Skip | undefined;
}

const NO_CARDS: ReadonlyMap<string, Card> = new Map();
const NO_SKIPS: ReadonlyMap<string, Skip> = new Map();

/** A card wins over a skip: a Posting with both was re-queued part way and shows as queued. */
const isQueued = (entry: Entry) => entry.card?.stage === "queued";
const isSkipped = (entry: Entry) => entry.skip !== undefined && entry.card === undefined;

function inView(entry: Entry, show: Show): boolean {
  switch (show) {
    case "all":
      return !isSkipped(entry);
    case "queued":
      return isQueued(entry);
    case "skipped":
      return isSkipped(entry);
  }
}

function JobList({
  meta,
  postings,
  updating,
  queue,
  actions,
  dailyQueueTarget,
  roleTypeOrder,
  now,
  resumeVariants,
  overrides,
  onChooseVariant,
  referrals,
  applications,
  onSaveApplication,
}: JobListProps) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [problem, setProblem] = useState<string | undefined>();
  const update = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setShown(PAGE_SIZE);
  };

  const cards = queue.kind === "ready" ? queue.cards : NO_CARDS;
  const skips = queue.kind === "ready" ? queue.skips : NO_SKIPS;
  const options = useMemo(() => filterOptions(postings, roleTypeOrder), [postings, roleTypeOrder]);
  const entries = useMemo(() => {
    const listed: Entry[] = postings.map((posting, index) => ({
      posting,
      rank: index + 1,
      card: cards.get(posting.id),
      skip: skips.get(posting.id),
    }));
    const ids = new Set(postings.map((p) => p.id));
    // Queued Postings that left the Job List stay visible after it, oldest first.
    const unlisted: Entry[] = [...cards.values()]
      .filter((card) => card.stage === "queued" && !ids.has(card.postingId))
      .sort(
        (a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.postingId.localeCompare(b.postingId),
      )
      .map((card) => ({
        posting: card.posting,
        rank: undefined,
        card,
        skip: skips.get(card.postingId),
      }));
    return [...listed, ...unlisted];
  }, [postings, cards, skips]);
  // A Posting that leaves the list (no longer listed nor queued) closes its drawer.
  const openEntry = openId === null ? undefined : entries.find((e) => e.posting.id === openId);
  const open = openEntry?.posting;
  const matches = useMemo(
    () =>
      entries.filter(
        (entry) => inView(entry, filters.show) && matchesFilters(entry.posting, filters, now),
      ),
    [entries, filters, now],
  );
  const counts = useMemo(
    () => ({
      all: entries.filter((e) => inView(e, "all")).length,
      queued: entries.filter(isQueued).length,
      skipped: entries.filter(isSkipped).length,
      possiblyClosed: entries.filter(
        (e) => isQueued(e) && e.card && queueAgeDays(e.card.queuedAt, now) >= POSSIBLY_CLOSED_DAYS,
      ).length,
    }),
    [entries, now],
  );
  const filtered = (Object.keys(filters) as (keyof Filters)[]).some(
    (key) => filters[key] !== NO_FILTERS[key],
  );
  const save = async (change: () => Promise<void>) => {
    try {
      await change();
      setProblem(undefined);
    } catch (error) {
      setProblem(saveProblem(error));
    }
  };

  return (
    <div class="job-list">
      <SourceProblems meta={meta} />
      <div class="job-list-status">
        <p>
          <strong>{count(meta.total, "Posting")}</strong> in your Job List
          {meta.matched > meta.total && (
            <>, the best of {count(meta.matched, "match", "matches")}</>
          )}
          . Refreshed {formatMoment(meta.refreshedAt)}.
        </p>
        {updating && (
          <p class="job-list-updating" role="status">
            Refresh is updating your Job List…
          </p>
        )}
      </div>

      {queue.kind === "failed" && (
        <p class="notice notice-problem" role="alert">
          Your Queue stopped loading. Reload the page to try again.
        </p>
      )}
      {problem && (
        <p class="notice notice-problem" role="alert">
          <ProblemText text={problem} />
        </p>
      )}

      {postings.length === 0 && entries.length === 0 ? (
        <div class="empty">
          <h2>No Postings matched your Search Profile</h2>
          <p>
            The last Refresh found nothing that fits your role types, seniority, start window and
            Location Tiers. Ask your Claude to tune your Search Profile, or refresh again later.
          </p>
        </div>
      ) : (
        <>
          <form
            class="filters"
            role="search"
            aria-label="Filter the Job List"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <fieldset class="filter filter-show">
              <legend class="filter-label">Show</legend>
              <div class="segments">
                {SHOW_OPTIONS.map(({ value, label }) => (
                  <label key={value} class="segment">
                    <input
                      type="radio"
                      name="job-list-show"
                      value={value}
                      checked={filters.show === value}
                      onChange={() => {
                        update({ show: value });
                      }}
                    />
                    <span>
                      {label} <span class="segment-count numeric">{counts[value]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div class="filter filter-search">
              <label class="filter-label" for="job-list-search">
                Search
              </label>
              <input
                id="job-list-search"
                type="search"
                value={filters.text}
                placeholder="Company, title or location"
                onInput={(event) => {
                  update({ text: event.currentTarget.value });
                }}
              />
            </div>
            <Select
              label="Role type"
              value={filters.roleType}
              onChange={(roleType) => {
                update({ roleType });
              }}
            >
              <option value="">All role types</option>
              {options.roleTypes.map((roleType) => (
                <option key={roleType} value={roleType}>
                  {roleType}
                </option>
              ))}
            </Select>
            <Select
              label="Location Tier"
              value={filters.tier}
              onChange={(tier) => {
                update({ tier });
              }}
            >
              <option value="">All tiers</option>
              {options.tiers.map((tier) => (
                <option key={tier} value={String(tier)}>
                  Tier {tier}
                </option>
              ))}
            </Select>
            <Select
              label="Source"
              value={filters.source}
              onChange={(source) => {
                update({ source });
              }}
            >
              <option value="">All Sources</option>
              {options.sources.map(({ name, lists }) =>
                lists.length === 0 ? (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ) : (
                  <optgroup key={name} label={name}>
                    <option value={name}>All of {name}</option>
                    {lists.map((list) => (
                      <option key={list} value={`${name}${LIST_SEPARATOR}${list}`}>
                        {list}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </Select>
            <Select
              label="Posted"
              value={filters.posted}
              onChange={(posted) => {
                update({ posted });
              }}
            >
              {POSTED_WINDOWS.map((window) => (
                <option key={window.value} value={window.value}>
                  {window.label}
                </option>
              ))}
            </Select>
          </form>

          <div class="job-list-count">
            <p aria-live="polite">
              {filtered
                ? `Showing ${count(matches.length, "Posting")} of ${postings.length.toLocaleString("en-US")}`
                : `Showing all ${count(matches.length, "Posting")}, best first`}
            </p>
            {filtered && (
              <button
                type="button"
                class="link-button"
                onClick={() => {
                  setFilters(NO_FILTERS);
                  setShown(PAGE_SIZE);
                }}
              >
                Clear filters
              </button>
            )}
          </div>

          {matches.length === 0 ? (
            <EmptyView show={filters.show} filtered={filtered} />
          ) : (
            <ol class="postings" aria-label="Job List">
              {matches.slice(0, shown).map((entry) => (
                <PostingRow
                  key={entry.posting.id}
                  entry={entry}
                  actions={queue.kind === "ready" ? actions : null}
                  save={save}
                  now={now}
                  variant={chosenVariant(
                    entry.posting,
                    overrides.get(entry.posting.id),
                    resumeVariants,
                  )}
                  onOpen={() => {
                    setOpenId(entry.posting.id);
                  }}
                />
              ))}
            </ol>
          )}

          {matches.length > shown && (
            <button
              type="button"
              class="show-more"
              onClick={() => {
                setShown((current) => current + PAGE_SIZE);
              }}
            >
              Show {Math.min(PAGE_SIZE, matches.length - shown)} more
            </button>
          )}
        </>
      )}

      {open && (
        <PostingDrawer
          posting={open}
          resumeVariants={resumeVariants}
          override={overrides.get(open.id)}
          onChooseVariant={(variant) => onChooseVariant(open, variant)}
          referrals={openEntry.card ? referrals.get(open.id) : undefined}
          application={
            openEntry.card ? { doc: applications.get(open.id), save: onSaveApplication } : undefined
          }
          onClose={() => {
            setOpenId(null);
          }}
          now={now}
        />
      )}

      <QueueBar
        queue={queue}
        size={counts.queued}
        possiblyClosed={counts.possiblyClosed}
        target={dailyQueueTarget}
      />
    </div>
  );
}

function EmptyView({ show, filtered }: { show: Show; filtered: boolean }) {
  const onlyShow = filtered && show !== "all";
  if (show === "queued" && onlyShow) {
    return (
      <div class="empty empty-compact">
        <h2>No queued Postings match</h2>
        <p>Tick a Posting to add it to your Queue, or clear the filters.</p>
      </div>
    );
  }
  if (show === "skipped" && onlyShow) {
    return (
      <div class="empty empty-compact">
        <h2>No skipped Postings match</h2>
        <p>Postings you untick from your Queue wait here, so you can un-skip them.</p>
      </div>
    );
  }
  return (
    <div class="empty empty-compact">
      <h2>No Postings match these filters</h2>
      <p>Try a broader search or clear the filters.</p>
    </div>
  );
}

function QueueBar({
  queue,
  size,
  possiblyClosed,
  target,
}: {
  queue: QueueState;
  size: number;
  possiblyClosed: number;
  target: number | undefined;
}) {
  return (
    <div class="queue-bar" role="region" aria-label="Queue">
      {queue.kind === "loading" ? (
        <p class="muted">Loading your Queue…</p>
      ) : (
        <p class="queue-bar-count">
          <span>
            <strong class="numeric">{size.toLocaleString("en-US")}</strong>{" "}
            {size === 1 ? "Posting" : "Postings"} in your Queue
          </span>
          {target !== undefined && <span class="muted numeric">Daily target {target}</span>}
          {possiblyClosed > 0 && (
            <span class="queue-bar-warning numeric">{possiblyClosed} possibly closed</span>
          )}
        </p>
      )}
      <a class="queue-bar-link" href="#progress">
        <span class="queue-bar-link-lead">Open the </span>Progress board
        <span aria-hidden="true"> →</span>
      </a>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: preact.ComponentChildren;
}) {
  const id = `job-list-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div class="filter">
      <label class="filter-label" for={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      >
        {children}
      </select>
    </div>
  );
}

const SHOWN_LOCATIONS = 2;

interface PostingRowProps {
  entry: Entry;
  /** Null while the Queue loads or when changes can't be saved. */
  actions: QueueActions | null;
  save: (change: () => Promise<void>) => Promise<void>;
  now: number;
  variant: ChosenVariant;
  onOpen: () => void;
}

function PostingRow({ entry, actions, save, now, variant, onOpen }: PostingRowProps) {
  const { posting, rank, card, skip } = entry;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const tick = useRef<HTMLButtonElement>(null);
  const queued = isQueued(entry);
  const skipped = isSkipped(entry);
  const extra = posting.locations.length - SHOWN_LOCATIONS;
  // A watchlist Posting's list is its own company, so it reads better as "Watchlist".
  const lists = [
    ...new Set(
      posting.sources.map((source) =>
        source.name === WATCHLIST_SOURCE ? WATCHLIST_SOURCE : (source.list ?? source.name),
      ),
    ),
  ];
  const age = queued && card ? queueAgeDays(card.queuedAt, now) : 0;
  const disabled = !actions || busy;

  const run = async (change: (actions: QueueActions) => Promise<void>) => {
    if (!actions) return;
    setBusy(true);
    await save(() => change(actions));
    setBusy(false);
  };
  const closePrompt = () => {
    setAsking(false);
    tick.current?.focus();
  };

  const classes = ["posting", queued && "posting-queued", skipped && "posting-skipped"];
  return (
    <li class={classes.filter(Boolean).join(" ")}>
      <div class="posting-tick">
        {(card === undefined || queued) && (
          <button
            ref={tick}
            type="button"
            role="checkbox"
            class="tick"
            aria-checked={queued}
            aria-disabled={disabled}
            aria-label={`${queued ? "In your Queue" : "Add to your Queue"}: ${posting.title} at ${posting.company}`}
            onClick={() => {
              if (disabled) return;
              if (queued) setAsking((open) => !open);
              else void run((a) => a.tick(posting, skipped));
            }}
          />
        )}
      </div>
      <span class="posting-rank numeric">
        {rank !== undefined && (
          <>
            <span class="visually-hidden">Rank </span>
            {rank}
          </>
        )}
      </span>
      <div class="posting-main">
        <h3 class="posting-title">
          <button type="button" class="posting-open" aria-haspopup="dialog" onClick={onOpen}>
            {posting.title}
          </button>
        </h3>
        <p class="posting-company">{posting.company}</p>
        <ul class="posting-facts">
          <li title={extra > 0 ? posting.locations.join("; ") : undefined}>
            {posting.locations.slice(0, SHOWN_LOCATIONS).join("; ")}
            {extra > 0 && <span class="muted"> +{extra} more</span>}
          </li>
          <li>Tier {posting.locationTier}</li>
          <li>{posting.roleType}</li>
          <li>{formatLevel(posting.level)}</li>
          <li>{formatPostedAge(posting.postedOn, now)}</li>
        </ul>
        <p class="posting-variant">
          Resume: <span class="posting-variant-name">{variant.name}</span>
          {variant.byCandidate && <span class="muted"> (your choice)</span>}
        </p>
        <QueueFlags entry={entry} age={age} />
        {skipped && skip && (
          <p class="posting-skip">
            <span class="flag">Skipped: {SKIP_REASON_LABELS[skip.reason].toLowerCase()}</span>
            <button
              type="button"
              class="link-button"
              aria-disabled={disabled}
              onClick={() => {
                if (!disabled) void run((a) => a.unskip(posting.id));
              }}
            >
              Un-skip
            </button>
          </p>
        )}
      </div>
      <div class="posting-side">
        <span class="score numeric" title="Score within its Location Tier, out of 100">
          <span class="visually-hidden">Score </span>
          {posting.score}
        </span>
        {posting.boosts.length > 0 && (
          <ul class="boosts" aria-label="Company boosts">
            {posting.boosts.map((boost) => (
              <li key={boost}>{boost}</li>
            ))}
          </ul>
        )}
        <p class="posting-sources">
          <span class="visually-hidden">Found in </span>
          {lists.join(", ")}
        </p>
      </div>
      {asking && queued && (
        <SkipPrompt
          title={posting.title}
          onCancel={closePrompt}
          onChoose={(reason) => {
            setAsking(false);
            void run((a) => a.skip(posting, reason));
          }}
        />
      )}
    </li>
  );
}

function QueueFlags({ entry, age }: { entry: Entry; age: number }) {
  const { card, rank } = entry;
  const flags: { text: string; warning?: boolean }[] = [];
  if (card?.stage === "closed" && card.closedReason) {
    flags.push({ text: `Closed: ${CLOSED_REASON_LABELS[card.closedReason]}` });
  } else if (card && card.stage !== "queued") {
    flags.push({ text: STAGE_LABELS[card.stage] });
  }
  if (isQueued(entry)) {
    if (rank === undefined) flags.push({ text: "No longer in your Job List", warning: true });
    if (age >= 1) flags.push({ text: `${count(age, "day")} in Queue` });
    if (age >= POSSIBLY_CLOSED_DAYS) flags.push({ text: "Possibly closed", warning: true });
  }
  if (flags.length === 0) return null;
  return (
    <ul class="flags">
      {flags.map(({ text, warning }) => (
        <li key={text} class={warning ? "flag flag-warning" : "flag"}>
          {text}
        </li>
      ))}
    </ul>
  );
}

function SkipPrompt({
  title,
  onChoose,
  onCancel,
}: {
  title: string;
  onChoose: (reason: SkipReason) => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    // Its scroll margin keeps the prompt clear of the sticky Queue bar.
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div
      ref={box}
      class="skip-prompt"
      role="group"
      aria-label={`Why skip ${title}?`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p class="skip-prompt-question" aria-hidden="true">
        Why skip it?
      </p>
      <div class="skip-prompt-reasons">
        {SKIP_REASONS.map((reason, index) => (
          <button
            key={reason}
            ref={index === 0 ? first : null}
            type="button"
            class="chip"
            onClick={() => {
              onChoose(reason);
            }}
          >
            {SKIP_REASON_LABELS[reason]}
          </button>
        ))}
        <button type="button" class="link-button skip-prompt-cancel" onClick={onCancel}>
          Keep in Queue
        </button>
      </div>
    </div>
  );
}

function filterOptions(postings: readonly Posting[], roleTypeOrder: readonly string[]) {
  const roleTypes = [...new Set(postings.map((p) => p.roleType))].sort((a, b) => {
    const order = (name: string) => {
      const index = roleTypeOrder.indexOf(name);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return order(a) - order(b) || a.localeCompare(b);
  });
  const tiers = [...new Set(postings.map((p) => p.locationTier))].sort((a, b) => a - b);
  const lists = new Map<string, Set<string>>();
  for (const posting of postings) {
    for (const source of posting.sources) {
      const known = lists.get(source.name) ?? new Set<string>();
      if (source.list) known.add(source.list);
      lists.set(source.name, known);
    }
  }
  const sources = [...lists]
    .map(([name, names]) => ({ name, lists: [...names].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roleTypes, tiers, sources };
}

function matchesFilters(posting: Posting, filters: Filters, now: number): boolean {
  if (filters.roleType && posting.roleType !== filters.roleType) return false;
  if (filters.tier && posting.locationTier !== Number(filters.tier)) return false;
  if (filters.source) {
    const [name, list] = filters.source.split(LIST_SEPARATOR);
    const found = posting.sources.some(
      (source) => source.name === name && (list === undefined || source.list === list),
    );
    if (!found) return false;
  }
  if (filters.posted && daysSincePosted(posting.postedOn, now) > Number(filters.posted)) {
    return false;
  }
  const words = filters.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const haystack = [posting.company, posting.title, ...posting.locations].join(" ").toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}
