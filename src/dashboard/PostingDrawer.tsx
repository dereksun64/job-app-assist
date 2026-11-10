/**
 * The detail drawer: one Posting's details, its Resume Variant and the Candidate's choice of it,
 * and the Referral Drafts for a queued Posting. It is shared: the Postings tab opens it today,
 * and the Progress board opens the same drawer for its cards, adding its own sections (Stage,
 * prepared answers) as children.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  JOB_FEED_SOURCE,
  chosenVariant,
  type Posting,
  type Referrals,
  type VariantOverride,
} from "../contract/index.ts";
import type { DbError } from "./db.ts";
import { formatLevel, formatPostedAge } from "./format.ts";
import { ReferralDrafts } from "./ReferralDrafts.tsx";

export interface PostingDrawerProps {
  posting: Posting;
  /** The names of the Candidate's Resume Variants, from the settings document. */
  resumeVariants: readonly string[];
  /** The Candidate's earlier choice of Resume Variant for this Posting, if any. */
  override: VariantOverride | undefined;
  /** Saves the Candidate's choice; rejects when the store refuses it. */
  onChooseVariant: (variant: string) => Promise<void>;
  /** The Posting's Referral Drafts; pass them only while the Posting has a card. */
  referrals?: Referrals | undefined;
  onClose: () => void;
  now: number;
  /** Sections the opening view adds below the Posting's details. */
  children?: ComponentChildren;
}

type Save =
  | { kind: "idle" }
  | { kind: "saving"; variant: string }
  | { kind: "saved" }
  | { kind: "failed"; message: string };

function whyNotSaved(error: unknown): string {
  const code = (error as Partial<DbError> | undefined)?.code;
  if (code === "quota_exceeded" || code === "resource_exhausted") {
    return "your dashboard storage is full.";
  }
  if (code === "unavailable") return "your dashboard data can't be reached. Try again.";
  return "something went wrong. Try again.";
}

function sourceText(posting: Posting): string {
  const byName = new Map<string, string[]>();
  for (const source of posting.sources) {
    const lists = byName.get(source.name) ?? [];
    if (source.list) lists.push(source.list);
    byName.set(source.name, lists);
  }
  return [...byName]
    .map(([name, lists]) => (lists.length > 0 ? `${name}: ${lists.join(", ")}` : name))
    .join("; ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function PostingDrawer({
  posting,
  resumeVariants,
  override,
  onChooseVariant,
  referrals,
  onClose,
  now,
  children,
}: PostingDrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const selectId = useId();
  const [save, setSave] = useState<Save>({ kind: "idle" });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    closeButton.current?.focus();
    return () => {
      if (element?.open) element.close();
      opener?.focus();
    };
  }, []);

  // A different Posting starts with a clean slate.
  useEffect(() => {
    setSave({ kind: "idle" });
  }, [posting.id]);

  const chosen = chosenVariant(posting, override, resumeVariants);
  const selected = save.kind === "saving" ? save.variant : chosen.name;
  const options = resumeVariants.includes(chosen.name)
    ? resumeVariants
    : [...resumeVariants, chosen.name];

  const choose = (variant: string) => {
    if (variant === chosen.name) return;
    setSave({ kind: "saving", variant });
    onChooseVariant(variant).then(
      () => {
        setSave({ kind: "saved" });
      },
      (error: unknown) => {
        setSave({ kind: "failed", message: `Your choice wasn't saved: ${whyNotSaved(error)}` });
      },
    );
  };

  return (
    <dialog
      ref={dialog}
      class="drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself, outside its panel.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="drawer-panel">
        <header class="drawer-header">
          <div>
            <p class="drawer-company">{posting.company}</p>
            <h2 class="drawer-title" id={titleId}>
              {posting.title}
            </h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            class="drawer-close"
            aria-label="Close"
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3.5 3.5l9 9m0-9l-9 9" />
            </svg>
          </button>
        </header>

        <div class="drawer-body">
          <a class="drawer-apply" href={posting.applyUrl} target="_blank" rel="noopener noreferrer">
            Open the Posting <span class="drawer-apply-host">on {hostOf(posting.applyUrl)}</span>
            <span aria-hidden="true"> ↗</span>
          </a>

          <section class="drawer-section" aria-labelledby={`${titleId}-variant`}>
            <h3 class="drawer-heading" id={`${titleId}-variant`}>
              Resume Variant
            </h3>
            {resumeVariants.length > 0 ? (
              <div class="variant-choice">
                <label class="visually-hidden" for={selectId}>
                  Resume Variant
                </label>
                <select
                  id={selectId}
                  value={selected}
                  disabled={save.kind === "saving"}
                  onChange={(event) => {
                    choose(event.currentTarget.value);
                  }}
                >
                  {options.map((name) => (
                    <option key={name} value={name}>
                      {name === chosen.pick.name ? `${name} (Refresh's pick)` : name}
                    </option>
                  ))}
                </select>
                <SaveStatus save={save} />
              </div>
            ) : (
              <p class="variant-name">{chosen.name}</p>
            )}
            {chosen.byCandidate ? (
              <>
                <p class="variant-reason">You chose this Resume Variant.</p>
                <p class="variant-reason muted">
                  Refresh picked {chosen.pick.name}. {chosen.pick.reason}
                </p>
              </>
            ) : (
              <p class="variant-reason">{chosen.pick.reason}</p>
            )}
            {save.kind === "failed" && (
              <p class="variant-error" role="alert">
                {save.message}
              </p>
            )}
          </section>

          {referrals && <ReferralDrafts referrals={referrals} company={posting.company} />}

          <section class="drawer-section" aria-labelledby={`${titleId}-details`}>
            <h3 class="drawer-heading" id={`${titleId}-details`}>
              Details
            </h3>
            <dl class="drawer-facts">
              <Fact label={posting.locations.length === 1 ? "Location" : "Locations"}>
                {posting.locations.join("; ")}
              </Fact>
              <Fact label="Location Tier">Tier {posting.locationTier}</Fact>
              <Fact label="Score">
                <span class="numeric">{posting.score}</span> out of 100
                {posting.boosts.length > 0 && (
                  <ul class="boosts drawer-boosts" aria-label="Company boosts">
                    {posting.boosts.map((boost) => (
                      <li key={boost}>{boost}</li>
                    ))}
                  </ul>
                )}
              </Fact>
              <Fact label="Role type">{posting.roleType}</Fact>
              <Fact label="Seniority">{formatLevel(posting.level)}</Fact>
              <Fact label="Posted">{formatPostedAge(posting.postedOn, now)}</Fact>
              <Fact label="Source">{sourceText(posting)}</Fact>
            </dl>
          </section>

          <section class="drawer-section" aria-labelledby={`${titleId}-description`}>
            <h3 class="drawer-heading" id={`${titleId}-description`}>
              Description
            </h3>
            {posting.description ? (
              <p class="drawer-description">{posting.description}</p>
            ) : (
              <p class="drawer-description muted">
                {posting.sources.every((source) => source.name === JOB_FEED_SOURCE)
                  ? "The Job Feed doesn't include descriptions."
                  : "This Posting's Source doesn't include a description."}{" "}
                Open the Posting to read the full description.
              </p>
            )}
          </section>

          {children}
        </div>
      </div>
    </dialog>
  );
}

function Fact({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="drawer-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function SaveStatus({ save }: { save: Save }) {
  return (
    <span class="variant-status" role="status">
      {save.kind === "saving" ? "Saving…" : save.kind === "saved" ? "Saved" : ""}
    </span>
  );
}
