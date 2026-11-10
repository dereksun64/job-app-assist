import { useEffect, useRef, useState } from "preact/hooks";
import {
  COMPANY_RULES,
  MAX_FRESHNESS_WEIGHT,
  ROLE_TYPE_PRIORITIES,
  type CompanyRule,
  type RoleTypePriority,
  type Settings,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";
import { saveSettings } from "./saveSettings.ts";
import type { SettingsState } from "./useSettings.ts";

export interface SettingsPanelProps {
  db: DashboardDb | null | undefined;
  state: SettingsState;
  now: number;
  onClose: () => void;
}

/** How long the note saying what was saved stays up. */
export const SAVED_NOTE_MS = 6000;

const SETUP_COMMAND = "/job-app-assist:setup";
const TUNE_COMMAND = "/job-app-assist:tune";

const PRIORITY_LABELS: Record<RoleTypePriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
const RULE_LABELS: Record<CompanyRule, { option: string; list: string; about: string }> = {
  boost: { option: "Boost", list: "Boosted", about: "ranked with the top companies" },
  lower: { option: "Lower", list: "Lowered", about: "ranked below companies with no rule" },
  block: { option: "Block", list: "Blocked", about: "left out of your Job List" },
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const SITE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A site's host name from what the Candidate typed: a host, or a link to a page on it. */
function siteFrom(text: string): string | undefined {
  let host = text.trim().toLowerCase();
  if (host.includes("/")) {
    try {
      host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname;
    } catch {
      return undefined;
    }
  }
  return SITE.test(host) ? host : undefined;
}

/** Applies a change to the settings and saves them; resolves true when the change is stored. */
type Save = (change: (draft: Settings) => void) => Promise<boolean>;

/**
 * The Settings panel: the daily Queue target, role type priorities, Location Tiers, company
 * boosts and blocks, blocked apply sites and the freshness weight. Each change saves the
 * settings document at once, the same document Tune edits, and applies on the next Refresh.
 */
export function SettingsPanel({ db, state, now, onClose }: SettingsPanelProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  useEffect(() => {
    if (saved === "") return;
    const timer = setTimeout(() => {
      setSaved("");
    }, SAVED_NOTE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [saved]);

  const ready = state.kind === "ready" && db ? { db, settings: state.settings } : undefined;

  const save: Save = async (change) => {
    if (!ready) return false;
    setBusy(true);
    setProblem(null);
    const result = await saveSettings(
      ready.db,
      ready.settings,
      change,
      new Date(now).toISOString(),
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(result.problem);
      setSaved("");
      return false;
    }
    if (result.changes.length > 0)
      setSaved(`Saved: ${result.changes.map((c) => c.text).join("; ")}.`);
    return true;
  };

  return (
    <dialog
      ref={dialog}
      class="sheet"
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div class="sheet-body">
        <header class="sheet-header">
          <h2 id="settings-title">Settings</h2>
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
          Changes save as you make them and apply on your next Refresh. You can also ask your Claude
          to change these in your own words with <code>{TUNE_COMMAND}</code>.
        </p>

        <StateNotice state={state} />

        {ready && (
          <>
            <QueueTargetSection settings={ready.settings} save={save} />
            <RoleTypesSection settings={ready.settings} busy={busy} save={save} />
            <LocationTiersSection settings={ready.settings} busy={busy} save={save} />
            <CompaniesSection settings={ready.settings} busy={busy} save={save} />
            <ApplySitesSection settings={ready.settings} busy={busy} save={save} />
            <FreshnessSection settings={ready.settings} save={save} />
          </>
        )}
        <div class="sheet-footer">
          {problem && (
            <p class="notice notice-problem" role="alert">
              {problem}
            </p>
          )}
          <p class="settings-saved" role="status">
            {saved}
          </p>
        </div>
      </div>
    </dialog>
  );
}

function StateNotice({ state }: { state: SettingsState }) {
  switch (state.kind) {
    case "ready":
      return null;
    case "connecting":
    case "loading":
      return (
        <p class="notice notice-quiet" role="status">
          Loading your settings…
        </p>
      );
    case "missing":
      return (
        <p class="notice" role="status">
          Setup isn't finished. Ask your Claude to run <code>{SETUP_COMMAND}</code> to save your
          Search Profile, then change your settings here.
        </p>
      );
    case "invalid":
      return (
        <p class="notice notice-problem" role="alert">
          Your settings don't match what this dashboard expects. Ask your Claude to run{" "}
          <code>{SETUP_COMMAND}</code> again to fix them.
        </p>
      );
    case "unavailable":
    case "failed":
      return (
        <p class="notice notice-problem" role="alert">
          Your settings can't be loaded right now. Reload the page to try again.
        </p>
      );
  }
}

function Section({
  id,
  title,
  about,
  children,
}: {
  id: string;
  title: string;
  about: preact.ComponentChildren;
  children: preact.ComponentChildren;
}) {
  const headingId = `setting-${id}`;
  return (
    <section class="setting" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <p class="setting-about">{about}</p>
      {children}
    </section>
  );
}

function FieldError({ id, error }: { id: string; error: string | null }) {
  return error ? (
    <p id={id} class="field-error">
      {error}
    </p>
  ) : null;
}

function RemoveButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="chip-remove"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" />
      </svg>
    </button>
  );
}

function QueueTargetSection({ settings, save }: { settings: Settings; save: Save }) {
  const [text, setText] = useState(String(settings.dailyQueueTarget));
  const [error, setError] = useState<string | null>(null);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    setText(String(settings.dailyQueueTarget));
    sent.current = null;
  }, [settings.dailyQueueTarget]);

  const commit = () => {
    const value = Number(text);
    if (text.trim() === "" || !Number.isInteger(value) || value < 1 || value > 100) {
      setError("Enter a whole number from 1 to 100.");
      return;
    }
    setError(null);
    if (value === settings.dailyQueueTarget || sent.current === text) return;
    sent.current = text;
    void save((draft) => {
      draft.dailyQueueTarget = value;
    });
  };

  return (
    <Section
      id="queue"
      title="Daily Queue target"
      about="Each Refresh tops your Queue up to this many Postings. A smaller Claude plan suits a smaller number."
    >
      <div class="setting-inline">
        <input
          id="queue-target"
          class="number-input"
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step={1}
          value={text}
          aria-labelledby="setting-queue"
          aria-invalid={error !== null}
          aria-describedby={error ? "queue-target-error" : undefined}
          onInput={(event) => {
            setText(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
          onBlur={commit}
        />
        <label for="queue-target" class="setting-unit">
          Postings a day
        </label>
      </div>
      <FieldError id="queue-target-error" error={error} />
    </Section>
  );
}

function RoleTypesSection({
  settings,
  busy,
  save,
}: {
  settings: Settings;
  busy: boolean;
  save: Save;
}) {
  const { roleTypes } = settings.searchProfile;
  const [name, setName] = useState("");
  const [priority, setPriority] = useState<RoleTypePriority>("medium");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const trimmed = name.trim();
    const existing = roleTypes.find((r) => same(r.name, trimmed));
    if (trimmed === "") {
      setError("Enter a role type, such as Data Engineer.");
      return;
    }
    if (existing) {
      setError(`${existing.name} is already one of your role types.`);
      return;
    }
    setError(null);
    if (
      await save((draft) => {
        draft.searchProfile.roleTypes.push({ name: trimmed, priority });
      })
    ) {
      setName("");
      setPriority("medium");
    }
  };

  return (
    <Section
      id="role-types"
      title="Role types"
      about="Priority is half of each Posting's score. Postings outside these role types stay out of your Job List."
    >
      <ul class="setting-rows">
        {roleTypes.map((role, index) => (
          <li key={role.name} class="setting-row">
            <span class="setting-row-name">{role.name}</span>
            <div class="segmented" role="radiogroup" aria-label={`${role.name} priority`}>
              {ROLE_TYPE_PRIORITIES.map((level) => (
                <label key={level} class="segment">
                  <input
                    type="radio"
                    name={`priority-${String(index)}`}
                    value={level}
                    checked={role.priority === level}
                    disabled={busy}
                    onChange={() => {
                      void save((draft) => {
                        const target = draft.searchProfile.roleTypes[index];
                        if (target) target.priority = level;
                      });
                    }}
                  />
                  <span>{PRIORITY_LABELS[level]}</span>
                </label>
              ))}
            </div>
            <RemoveButton
              label={`Remove ${role.name}`}
              disabled={busy || roleTypes.length === 1}
              onClick={() => {
                const aimed = settings.resumeVariants.filter((v) =>
                  v.roleTypes.some((name) => same(name, role.name)),
                );
                if (aimed.length > 0) {
                  const names = aimed.map((v) => v.name).join(" and ");
                  setError(
                    `${role.name} stays while ${names} ${aimed.length === 1 ? "is" : "are"} aimed at it. Ask your Claude to change your Resume Variants first.`,
                  );
                  return;
                }
                setError(null);
                void save((draft) => {
                  draft.searchProfile.roleTypes.splice(index, 1);
                });
              }}
            />
          </li>
        ))}
      </ul>
      <form
        class="setting-form setting-form-role"
        aria-label="Add a role type"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label class="field">
          <span class="field-label">New role type</span>
          <input
            type="text"
            value={name}
            placeholder="Data Engineer"
            aria-invalid={error !== null}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setError(null);
            }}
          />
        </label>
        <label class="field">
          <span class="field-label">Priority</span>
          <select
            value={priority}
            onChange={(event) => {
              setPriority(event.currentTarget.value as RoleTypePriority);
            }}
          >
            {ROLE_TYPE_PRIORITIES.map((level) => (
              <option key={level} value={level}>
                {PRIORITY_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" class="button" disabled={busy}>
          Add role type
        </button>
        <FieldError id="role-type-error" error={error} />
      </form>
    </Section>
  );
}

function LocationTiersSection({
  settings,
  busy,
  save,
}: {
  settings: Settings;
  busy: boolean;
  save: Save;
}) {
  const tiers = settings.searchProfile.locationTiers;
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [error, setError] = useState<{ tier: number; text: string } | null>(null);
  const onlyOne = tiers.length === 1 && tiers[0]?.locations.length === 1;
  const newTier = tiers.length;

  /** Where a location already is, as "Tier N", if anywhere. */
  const tierOf = (location: string) => {
    const index = tiers.findIndex((t) => t.locations.some((l) => same(l, location)));
    if (index === -1) return undefined;
    const spelled = tiers[index]?.locations.find((l) => same(l, location)) ?? location;
    return { label: `Tier ${String(index + 1)}`, spelled };
  };

  const add = async (tier: number) => {
    const location = (drafts[tier] ?? "").trim();
    if (location === "") {
      setError({ tier, text: "Enter a location, such as Seattle." });
      return;
    }
    const existing = tierOf(location);
    if (existing) {
      setError({ tier, text: `${existing.spelled} is already in ${existing.label}.` });
      return;
    }
    setError(null);
    const stored = await save((draft) => {
      const target = draft.searchProfile.locationTiers[tier];
      if (target) target.locations.push(location);
      else draft.searchProfile.locationTiers.push({ locations: [location] });
    });
    if (stored) setDrafts((current) => ({ ...current, [tier]: "" }));
  };

  const draftInput = (tier: number, label: string, placeholder: string) => (
    <input
      type="text"
      aria-label={label}
      placeholder={placeholder}
      value={drafts[tier] ?? ""}
      aria-invalid={error?.tier === tier}
      onInput={(event) => {
        const value = event.currentTarget.value;
        setDrafts((current) => ({ ...current, [tier]: value }));
        setError(null);
      }}
    />
  );

  return (
    <Section
      id="location-tiers"
      title="Location Tiers"
      about="Postings in Tier 1 come first; lower tiers only fill Queue slots higher tiers leave empty. Remote is a location like any other."
    >
      {tiers.map((tier, index) => {
        const label = `Tier ${String(index + 1)}`;
        return (
          <div key={index} class="tier">
            <h4 class="tier-label">{label}</h4>
            <ul class="chips" aria-label={label}>
              {tier.locations.map((location) => (
                <li key={location} class="chip">
                  <span>{location}</span>
                  <RemoveButton
                    label={`Remove ${location} from ${label}`}
                    disabled={busy || onlyOne}
                    onClick={() => {
                      void save((draft) => {
                        const target = draft.searchProfile.locationTiers[index];
                        if (!target) return;
                        target.locations = target.locations.filter((l) => l !== location);
                        if (target.locations.length === 0)
                          draft.searchProfile.locationTiers.splice(index, 1);
                      });
                    }}
                  />
                </li>
              ))}
            </ul>
            <form
              class="chip-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void add(index);
              }}
            >
              {draftInput(index, `Add a location to ${label}`, "Add a location")}
              <button type="submit" class="button button-quiet" disabled={busy}>
                Add
              </button>
            </form>
            {error?.tier === index && (
              <FieldError id={`tier-${String(index)}-error`} error={error.text} />
            )}
          </div>
        );
      })}
      {tiers.length < 10 && (
        <form
          class="chip-form tier-new"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void add(newTier);
          }}
        >
          {draftInput(
            newTier,
            `Start Tier ${String(newTier + 1)} with a location`,
            `Start Tier ${String(newTier + 1)} with a location`,
          )}
          <button type="submit" class="button button-quiet" disabled={busy}>
            Add Tier {newTier + 1}
          </button>
        </form>
      )}
      {error?.tier === newTier && <FieldError id="tier-new-error" error={error.text} />}
    </Section>
  );
}

function CompaniesSection({
  settings,
  busy,
  save,
}: {
  settings: Settings;
  busy: boolean;
  save: Save;
}) {
  const { companies } = settings;
  const [name, setName] = useState("");
  const [rule, setRule] = useState<CompanyRule>("boost");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Enter a company name.");
      return;
    }
    const current = COMPANY_RULES.find((r) => companies[r].some((c) => same(c, trimmed)));
    if (current === rule) {
      setError(`${trimmed} is already ${RULE_LABELS[rule].list.toLowerCase()}.`);
      return;
    }
    setError(null);
    const stored = await save((draft) => {
      for (const r of COMPANY_RULES)
        draft.companies[r] = draft.companies[r].filter((c) => !same(c, trimmed));
      draft.companies[rule].push(trimmed);
    });
    if (stored) setName("");
  };

  return (
    <Section
      id="companies"
      title="Companies"
      about="On top of the default boosts for Fortune 500 companies and the Job Feed's company tiers."
    >
      {COMPANY_RULES.map((r) => {
        const { list, about } = RULE_LABELS[r];
        return (
          <div key={r} class="tier">
            <h4 class="tier-label">
              {list} <span class="tier-hint">{about}</span>
            </h4>
            {companies[r].length === 0 ? (
              <p class="chips-empty">No {list.toLowerCase()} companies.</p>
            ) : (
              <ul class={`chips chips-${r}`} aria-label={list}>
                {companies[r].map((company) => (
                  <li key={company} class="chip">
                    <span>{company}</span>
                    <RemoveButton
                      label={`Remove ${company} from ${list}`}
                      disabled={busy}
                      onClick={() => {
                        void save((draft) => {
                          draft.companies[r] = draft.companies[r].filter((c) => c !== company);
                        });
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <form
        class="setting-form setting-form-company"
        aria-label="Add a company rule"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label class="field">
          <span class="field-label">Company</span>
          <input
            type="text"
            value={name}
            placeholder="Company name"
            aria-invalid={error !== null}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setError(null);
            }}
          />
        </label>
        <label class="field">
          <span class="field-label">Rule</span>
          <select
            value={rule}
            onChange={(event) => {
              setRule(event.currentTarget.value as CompanyRule);
            }}
          >
            {COMPANY_RULES.map((r) => (
              <option key={r} value={r}>
                {RULE_LABELS[r].option}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" class="button" disabled={busy}>
          Add company
        </button>
        <FieldError id="company-error" error={error} />
      </form>
    </Section>
  );
}

function ApplySitesSection({
  settings,
  busy,
  save,
}: {
  settings: Settings;
  busy: boolean;
  save: Save;
}) {
  const sites = settings.blockedApplySites;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const site = siteFrom(text);
    if (!site) {
      setError("Enter a site's host name, such as myworkdayjobs.com.");
      return;
    }
    if (sites.includes(site)) {
      setError(`${site} is already blocked.`);
      return;
    }
    setError(null);
    if (
      await save((draft) => {
        draft.blockedApplySites.push(site);
      })
    )
      setText("");
  };

  return (
    <Section
      id="apply-sites"
      title="Blocked apply sites"
      about="Postings you can only apply to on these sites, or their subdomains, stay out of your Job List. Workday, for example, is myworkdayjobs.com."
    >
      {sites.length === 0 ? (
        <p class="chips-empty">No blocked sites.</p>
      ) : (
        <ul class="chips chips-block" aria-label="Blocked sites">
          {sites.map((site) => (
            <li key={site} class="chip">
              <span>{site}</span>
              <RemoveButton
                label={`Unblock ${site}`}
                disabled={busy}
                onClick={() => {
                  void save((draft) => {
                    draft.blockedApplySites = draft.blockedApplySites.filter((s) => s !== site);
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <form
        class="setting-form setting-form-site"
        aria-label="Block an apply site"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label class="field">
          <span class="field-label">Site</span>
          <input
            type="text"
            value={text}
            placeholder="myworkdayjobs.com"
            autoCapitalize="none"
            spellcheck={false}
            aria-invalid={error !== null}
            onInput={(event) => {
              setText(event.currentTarget.value);
              setError(null);
            }}
          />
        </label>
        <button type="submit" class="button" disabled={busy}>
          Block site
        </button>
        <FieldError id="site-error" error={error} />
      </form>
    </Section>
  );
}

function FreshnessSection({ settings, save }: { settings: Settings; save: Save }) {
  const [value, setValue] = useState(settings.freshnessWeight);

  useEffect(() => {
    setValue(settings.freshnessWeight);
  }, [settings.freshnessWeight]);

  const rest = 100 - value;
  const fit = Math.round((rest * 5) / 8);
  const boost = rest - fit;

  return (
    <Section
      id="freshness"
      title="Freshness weight"
      about="How much a Posting's age counts toward its score. Role type priority and company boosts share the rest."
    >
      <div class="slider-row">
        <input
          type="range"
          class="slider"
          min={0}
          max={MAX_FRESHNESS_WEIGHT}
          step={5}
          value={value}
          aria-labelledby="setting-freshness"
          aria-valuetext={`${String(value)}%`}
          onInput={(event) => {
            setValue(Number(event.currentTarget.value));
          }}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (next === settings.freshnessWeight) return;
            void save((draft) => {
              draft.freshnessWeight = next;
            });
          }}
        />
        <span class="slider-value" aria-hidden="true">
          {value}%
        </span>
      </div>
      <p class="setting-split">
        Score: role type {fit}%, company {boost}%, freshness {value}%
      </p>
    </Section>
  );
}
