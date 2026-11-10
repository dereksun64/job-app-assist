import { useState } from "preact/hooks";
import type {
  CompanyNews,
  CompanyNewsKind,
  Forum,
  ForumHighlight,
  HiringSignal,
  IndustryStory,
  IndustryTopic,
  NewsDigest,
  NewsSection,
} from "../contract/index.ts";
import { FORUMS } from "../contract/index.ts";
import { formatDate, formatDay, formatLevel, formatMoment, formatShortDay } from "./format.ts";
import type { NewsState } from "./useNews.ts";

const KIND_LABELS: Record<CompanyNewsKind, string> = {
  layoffs: "Layoffs",
  hiring_freeze: "Hiring freeze",
  hiring: "Hiring",
  funding: "Funding",
  acquisition: "Acquisition",
  other: "News",
};

const TOPIC_LABELS: Record<IndustryTopic, string> = {
  ai: "AI and LLMs",
  big_tech: "Big tech",
  entry_level_market: "Entry-level market",
};

/** Company news that may change whether to apply gets the warning color. */
const WARNING_KINDS = new Set<CompanyNewsKind>(["layoffs", "hiring_freeze"]);

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export interface NewsTabProps {
  state: NewsState;
  now: number;
}

export function NewsTab({ state, now }: NewsTabProps) {
  switch (state.kind) {
    case "loading":
      return null;
    case "failed":
      return (
        <p class="notice notice-problem" role="alert">
          Your News Digest stopped loading. Reload the page to try again.
        </p>
      );
    case "invalid":
      return (
        <p class="notice notice-problem" role="alert">
          Your News Digest doesn't match what this dashboard expects. Ask your Claude to refresh
          again to rebuild it.
        </p>
      );
    case "empty":
      return (
        <div class="empty">
          <h2>No News Digest yet</h2>
          <p>
            Each Refresh writes a News Digest here: hiring signals from your Postings, forum
            highlights, news about companies in your Queue, and the wider tech stories worth knowing
            for interviews. Ask your Claude to refresh.
          </p>
        </div>
      );
    case "ready":
      return <Digests digests={state.digests} now={now} />;
  }
}

function Digests({ digests, now }: { digests: readonly NewsDigest[]; now: number }) {
  // The chosen day, or undefined for the newest; it stays put when a new digest arrives.
  const [chosen, setChosen] = useState<string | undefined>();
  const index = Math.max(
    0,
    digests.findIndex((d) => d.day === chosen),
  );
  const digest = digests[index] as NewsDigest;
  const show = (i: number) => {
    setChosen(digests[i]?.day);
  };

  return (
    <article class="digest" aria-labelledby="digest-day">
      <header class="digest-header">
        <div class="digest-title">
          <p class="digest-kicker">News Digest</p>
          <h2 id="digest-day">{formatDay(digest.day)}</h2>
          <p class="digest-meta">
            <span>
              <strong class="numeric">{digest.newThisWeek.toLocaleString("en-US")}</strong>{" "}
              {digest.newThisWeek === 1 ? "Posting" : "Postings"} in your Job List went up this week
            </span>
            <span>Built {formatMoment(digest.builtAt)}</span>
          </p>
        </div>
        <nav class="day-nav" aria-label="Past days">
          <button
            type="button"
            class="day-step"
            aria-label="Older day"
            disabled={index >= digests.length - 1}
            onClick={() => {
              show(index + 1);
            }}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <label class="day-pick">
            <span class="visually-hidden">Day</span>
            <select
              value={digest.day}
              onChange={(event) => {
                setChosen(event.currentTarget.value);
              }}
            >
              {digests.map((d) => (
                <option key={d.day} value={d.day}>
                  {formatShortDay(d.day)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            class="day-step"
            aria-label="Newer day"
            disabled={index === 0}
            onClick={() => {
              show(index - 1);
            }}
          >
            <span aria-hidden="true">›</span>
          </button>
        </nav>
      </header>

      <NewsSectionCard
        id="hiringSignals"
        title="Hiring signals"
        lead="Fortune 500 and top-tier companies with new entry-level Postings in your Job List."
        digest={digest}
        empty="No Fortune 500 or top-tier company opened entry-level Postings in your Job List this week."
      >
        {digest.hiringSignals.length > 0 && (
          <Signals key={digest.day} signals={digest.hiringSignals} now={now} />
        )}
      </NewsSectionCard>

      <NewsSectionCard
        id="forumHighlights"
        title="Forum highlights"
        lead="What other candidates are discussing on r/csMajors, r/cscareerquestions and Hacker News."
        digest={digest}
        empty="Nothing stood out on the forums today."
      >
        {digest.forumHighlights.length > 0 && <Forums highlights={digest.forumHighlights} />}
      </NewsSectionCard>

      <NewsSectionCard
        id="companyNews"
        title="Company news"
        lead="Layoffs, hiring freezes, funding and other news about companies in your Queue."
        digest={digest}
        empty="Nothing notable about the companies in your Queue today."
      >
        {digest.companyNews.length > 0 && (
          <ul class="news-list">
            {digest.companyNews.map((item) => (
              <CompanyItem key={item.url} item={item} now={now} />
            ))}
          </ul>
        )}
      </NewsSectionCard>

      <NewsSectionCard
        id="industryNews"
        title="Industry news"
        lead="AI, big tech and the entry-level market: worth knowing for interviews."
        digest={digest}
        empty="No industry stories today."
      >
        {digest.industryNews.length > 0 && (
          <ul class="news-list">
            {digest.industryNews.map((story) => (
              <Story key={story.url} story={story} now={now} />
            ))}
          </ul>
        )}
      </NewsSectionCard>
    </article>
  );
}

function NewsSectionCard({
  id,
  title,
  lead,
  digest,
  empty,
  children,
}: {
  id: NewsSection;
  title: string;
  lead: string;
  digest: NewsDigest;
  empty: string;
  children: preact.ComponentChildren;
}) {
  const gaps = digest.gaps.filter((gap) => gap.section === id);
  const items = digest[id].length;
  return (
    <section class="news-section" aria-labelledby={`news-${id}`}>
      <header class="news-section-header">
        <h3 id={`news-${id}`}>{title}</h3>
        <p class="muted">{lead}</p>
      </header>
      {children}
      {items === 0 && gaps.length === 0 && <p class="news-empty">{empty}</p>}
      {gaps.map((gap) => (
        <p key={gap.note} class="news-gap">
          {gap.note}
        </p>
      ))}
    </section>
  );
}

function SourceLink({ href, children }: { href: string; children: preact.ComponentChildren }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** The strongest signals show at first; the rest are one click away. */
export const SIGNALS_SHOWN = 5;

function Signals({ signals, now }: { signals: readonly HiringSignal[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? signals : signals.slice(0, SIGNALS_SHOWN);
  const hidden = signals.length - shown.length;
  return (
    <>
      <ul class="news-list">
        {shown.map((signal) => (
          <Signal key={signal.company} signal={signal} now={now} />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          class="link-button news-more"
          onClick={() => {
            setAll(true);
          }}
        >
          Show {count(hidden, "more company", "more companies")}
        </button>
      )}
    </>
  );
}

function Signal({ signal, now }: { signal: HiringSignal; now: number }) {
  return (
    <li class="news-item">
      <div class="signal-head">
        <span class="signal-company">{signal.company}</span>
        <ul class="boosts" aria-label="Boosts">
          {signal.boosts.map((boost) => (
            <li key={boost}>{boost}</li>
          ))}
        </ul>
        <span class="signal-count">{count(signal.newPostings, "new Posting")} this week</span>
      </div>
      <ul class="signal-postings">
        {signal.postings.map((posting) => (
          <li key={posting.id}>
            <span class="news-headline">
              <SourceLink href={posting.applyUrl}>{posting.title}</SourceLink>
            </span>
            <span class="news-byline">
              {formatLevel(posting.level)} · Posted {formatDate(posting.postedOn, now)}
            </span>
          </li>
        ))}
        {signal.newPostings > signal.postings.length && (
          <li class="signal-more">
            and {signal.newPostings - signal.postings.length} more on the{" "}
            <a href="#postings">Postings tab</a>
          </li>
        )}
      </ul>
    </li>
  );
}

function Forums({ highlights }: { highlights: readonly ForumHighlight[] }) {
  const groups = FORUMS.map((forum) => ({
    forum,
    items: highlights.filter((h) => h.forum === forum),
  })).filter((group) => group.items.length > 0);
  return (
    <div class="forums">
      {groups.map(({ forum, items }) => (
        <div key={forum} class="forum">
          <h4 class="forum-name">{forum satisfies Forum}</h4>
          <ul class="news-list">
            {items.map((item) => (
              <li key={item.url} class="news-item">
                <span class="news-headline">
                  <SourceLink href={item.url}>{item.title}</SourceLink>
                </span>
                <p>{item.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CompanyItem({ item, now }: { item: CompanyNews; now: number }) {
  return (
    <li class="news-item">
      <div class="news-labels">
        <span class="signal-company">{item.company}</span>
        <span class={WARNING_KINDS.has(item.kind) ? "flag flag-warning" : "flag"}>
          {KIND_LABELS[item.kind]}
        </span>
      </div>
      <span class="news-headline">
        <SourceLink href={item.url}>{item.headline}</SourceLink>
      </span>
      <p>{item.summary}</p>
      <span class="news-byline">
        {item.source} · {formatDate(item.publishedOn, now)}
      </span>
    </li>
  );
}

function Story({ story, now }: { story: IndustryStory; now: number }) {
  return (
    <li class="news-item">
      <span class="news-topic">{TOPIC_LABELS[story.topic]}</span>
      <span class="news-headline">
        <SourceLink href={story.url}>{story.headline}</SourceLink>
      </span>
      <p>{story.summary}</p>
      <p class="why">
        <strong>Why it matters:</strong> {story.whyItMatters}
      </p>
      <span class="news-byline">
        {story.source} · {formatDate(story.publishedOn, now)}
      </span>
    </li>
  );
}
