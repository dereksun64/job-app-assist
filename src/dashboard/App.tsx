import { useCallback, useMemo, useRef, useState } from "preact/hooks";
import {
  ROLE_TYPE_PRIORITIES,
  type Posting,
  type RoleType,
  type RoleTypePriority,
  type Settings,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";
import { formatSeniority, formatStartWindow } from "./format.ts";
import { NewsTab } from "./NewsTab.tsx";
import { PostingsTab } from "./PostingsTab.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SourcesPanel } from "./SourcesPanel.tsx";
import { ProgressTab } from "./ProgressTab.tsx";
import { useHashTab } from "./useHashTab.ts";
import { useJobList } from "./useJobList.ts";
import { useNews } from "./useNews.ts";
import { queueActions, useQueue } from "./useQueue.ts";
import { useReferrals } from "./useReferrals.ts";
import { useSettings, type SettingsState } from "./useSettings.ts";
import { useVariantOverrides } from "./useVariantOverrides.ts";
import { useSources } from "./useSources.ts";

export { LOADING_TIMEOUT_MS } from "./useSettings.ts";

const TABS = ["news", "postings", "progress"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  news: "News",
  postings: "Postings",
  progress: "Progress",
};

const PRIORITY_LABELS: Record<RoleTypePriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const SETUP_COMMAND = "/job-app-assist:setup";

export interface AppProps {
  /** The `db` capability: undefined while it resolves, null when this view has none. */
  db: DashboardDb | null | undefined;
  pageVersion: string;
  /** The current time in milliseconds; tests fix it, the page reads the clock. */
  now?: number;
}

export function App({ db, pageVersion, now }: AppProps) {
  const settings = useSettings(db);
  const jobList = useJobList(db);
  const news = useNews(db);
  const queue = useQueue(db);
  const actions = useMemo(() => (db ? queueActions(db, () => now ?? Date.now()) : null), [db, now]);
  const sources = useSources(db);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const roleTypeOrder = useMemo(
    () =>
      settings.kind === "ready" ? settings.settings.searchProfile.roleTypes.map((r) => r.name) : [],
    [settings],
  );
  const resumeVariants = useMemo(
    () => (settings.kind === "ready" ? settings.settings.resumeVariants.map((v) => v.name) : []),
    [settings],
  );
  const listed = useMemo(
    () =>
      jobList.kind === "ready"
        ? new Map<string, Posting>(jobList.postings.map((p) => [p.id, p]))
        : undefined,
    [jobList],
  );
  const clock = useCallback(() => now ?? Date.now(), [now]);
  const { overrides, choose } = useVariantOverrides(db, clock);
  const referrals = useReferrals(db);
  const [tab, selectTab] = useHashTab(TABS);
  // When the whole database stops loading, the notice above the tabs says so once; the tabs
  // stay quiet instead of repeating it.
  const down = settings.kind === "failed";

  return (
    <div class="shell">
      <header class="masthead">
        <h1 class="wordmark">Job App Assist</h1>
        {settings.kind === "ready" && <ProfileSummary settings={settings.settings} />}
      </header>
      <Notice state={settings} />
      <main class="workspace">
        <div class="workspace-bar">
          <Tabs tab={tab} onSelect={selectTab} />
          <button
            type="button"
            class="bar-button"
            aria-haspopup="dialog"
            onClick={() => {
              setSourcesOpen(true);
            }}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
              <circle
                cx="5"
                cy="4"
                r="1.75"
                fill="var(--surface)"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <circle
                cx="11"
                cy="8"
                r="1.75"
                fill="var(--surface)"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <circle
                cx="7"
                cy="12"
                r="1.75"
                fill="var(--surface)"
                stroke="currentColor"
                stroke-width="1.5"
              />
            </svg>
            <span class="bar-button-label">Sources</span>
          </button>
          <button
            type="button"
            class="bar-button"
            aria-haspopup="dialog"
            onClick={() => {
              setSettingsOpen(true);
            }}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M3 2.5v11M8 2.5v11M13 2.5v11"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
              <rect
                x="1.25"
                y="8.5"
                width="3.5"
                height="2.5"
                rx="1"
                fill="var(--surface)"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <rect
                x="6.25"
                y="4"
                width="3.5"
                height="2.5"
                rx="1"
                fill="var(--surface)"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <rect
                x="11.25"
                y="9.5"
                width="3.5"
                height="2.5"
                rx="1"
                fill="var(--surface)"
                stroke="currentColor"
                stroke-width="1.5"
              />
            </svg>
            <span class="bar-button-label">Settings</span>
          </button>
        </div>
        <section
          class="panel"
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          tabIndex={0}
        >
          {tab === "news" && (
            <NewsTab state={down ? { kind: "loading" } : news} now={now ?? Date.now()} />
          )}
          {tab === "postings" && (
            <PostingsTab
              state={down ? { kind: "loading" } : jobList}
              queue={queue}
              actions={actions}
              dailyQueueTarget={
                settings.kind === "ready" ? settings.settings.dailyQueueTarget : undefined
              }
              roleTypeOrder={roleTypeOrder}
              now={now ?? Date.now()}
              resumeVariants={resumeVariants}
              overrides={overrides}
              onChooseVariant={choose}
              referrals={referrals}
            />
          )}
          {tab === "progress" && (
            <ProgressTab
              queue={queue}
              listed={listed}
              actions={actions}
              now={now ?? Date.now()}
              resumeVariants={resumeVariants}
              overrides={overrides}
              onChooseVariant={choose}
              referrals={referrals}
            />
          )}
        </section>
      </main>
      <footer class="colophon">Toolkit page {pageVersion}</footer>
      {settingsOpen && (
        <SettingsPanel
          db={db}
          state={settings}
          now={now ?? Date.now()}
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}
      {sourcesOpen && (
        <SourcesPanel
          db={db}
          state={sources}
          jobList={jobList}
          now={now ?? Date.now()}
          onClose={() => {
            setSourcesOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Tabs({ tab, onSelect }: { tab: Tab; onSelect: (tab: Tab) => void }) {
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const move = (event: KeyboardEvent) => {
    const index = TABS.indexOf(tab);
    const target =
      event.key === "ArrowRight"
        ? TABS[(index + 1) % TABS.length]
        : event.key === "ArrowLeft"
          ? TABS[(index - 1 + TABS.length) % TABS.length]
          : event.key === "Home"
            ? TABS[0]
            : event.key === "End"
              ? TABS[TABS.length - 1]
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    onSelect(target);
    refs.current[target]?.focus();
  };

  return (
    <div class="tabs" role="tablist" aria-label="Dashboard" onKeyDown={move}>
      {TABS.map((name) => (
        <button
          key={name}
          ref={(el) => {
            refs.current[name] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${name}`}
          class="tab"
          aria-selected={tab === name}
          aria-controls={`panel-${name}`}
          tabIndex={tab === name ? 0 : -1}
          onClick={() => {
            onSelect(name);
          }}
        >
          {TAB_LABELS[name]}
        </button>
      ))}
    </div>
  );
}

function ProfileSummary({ settings }: { settings: Settings }) {
  const { searchProfile, dailyQueueTarget } = settings;
  return (
    <section class="profile" aria-label="Search Profile">
      <dl>
        <div class="fact fact-wide">
          <dt>Role types</dt>
          <dd>
            <RoleTypes roleTypes={searchProfile.roleTypes} />
          </dd>
        </div>
        <div class="fact">
          <dt>Seniority</dt>
          <dd>{formatSeniority(searchProfile.seniority)}</dd>
        </div>
        <div class="fact">
          <dt>Start</dt>
          <dd>{formatStartWindow(searchProfile.startWindow)}</dd>
        </div>
        <div class="fact">
          <dt>Daily Queue target</dt>
          <dd class="numeric">{dailyQueueTarget} a day</dd>
        </div>
        <div class="fact fact-wide">
          <dt>Location Tiers</dt>
          <dd>
            <ul class="groups">
              {searchProfile.locationTiers.map((tier, index) => (
                <li key={index}>
                  <span class="group-label">Tier {index + 1}:</span> {tier.locations.join(", ")}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function RoleTypes({ roleTypes }: { roleTypes: readonly RoleType[] }) {
  const groups = ROLE_TYPE_PRIORITIES.map((priority) => ({
    priority,
    names: roleTypes.filter((role) => role.priority === priority).map((role) => role.name),
  })).filter((group) => group.names.length > 0);
  if (groups.length === 1) return <>{groups[0]?.names.join(", ")}</>;
  return (
    <ul class="groups">
      {groups.map(({ priority, names }) => (
        <li key={priority}>
          <span class="group-label">{PRIORITY_LABELS[priority]} priority:</span> {names.join(", ")}
        </li>
      ))}
    </ul>
  );
}

function Notice({ state }: { state: SettingsState }) {
  switch (state.kind) {
    case "ready":
      return null;
    case "connecting":
    case "loading":
      return (
        <p class="notice notice-quiet" role="status">
          {state.kind === "loading" && state.slow
            ? "Your dashboard data can't be reached yet. It will appear here as soon as it loads."
            : "Loading your dashboard…"}
        </p>
      );
    case "missing":
      return (
        <p class="notice" role="status">
          Setup isn't finished. Ask your Claude to run <code>{SETUP_COMMAND}</code> to save your
          Search Profile.
        </p>
      );
    case "unavailable":
      return (
        <p class="notice notice-problem" role="alert">
          Your dashboard data isn't available here. Open this page in claude.ai while signed in to
          the account that ran Setup.
        </p>
      );
    case "failed":
      return (
        <p class="notice notice-problem" role="alert">
          Your dashboard data stopped loading. Reload the page to try again.
        </p>
      );
    case "invalid":
      return (
        <div class="notice notice-problem" role="alert">
          <p>
            Your settings don't match what this dashboard expects. Ask your Claude to run{" "}
            <code>{SETUP_COMMAND}</code> again to fix them.
          </p>
          <ul class="issues">
            {state.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      );
  }
}
