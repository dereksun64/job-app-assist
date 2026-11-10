/**
 * The Referral Drafts section of the detail drawer: a short message per connection at the
 * Posting's company, each with a copy button and a LinkedIn people search. The page never sends
 * anything and never acts on LinkedIn; the Candidate copies a draft and sends it themselves.
 */
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ReferralDraft, Referrals } from "../contract/index.ts";

/** How long "Copied" shows before the button reads "Copy message" again. */
const COPIED_MS = 2000;

/** A LinkedIn people search for the connection, for the Candidate to open themselves. */
export function linkedInSearchUrl(draft: ReferralDraft): string {
  const keywords = encodeURIComponent(`${draft.name} ${draft.company}`.replace(/\s+/g, " "));
  return `https://www.linkedin.com/search/results/people/?keywords=${keywords}`;
}

/**
 * Puts text on the clipboard. The Artifact frame may not grant the Clipboard API, so this falls
 * back to copying a selection. Rejects when neither works.
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall back to copying a selection below.
  }
  // Selecting the text moves focus; it goes back to where it was, so keyboard users keep their place.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  // Inside the open modal drawer, so the selection is not blocked by the modal.
  (document.querySelector("dialog[open]") ?? document.body).append(area);
  try {
    area.select();
    // execCommand is deprecated but is the only copy path when the Clipboard API is not granted.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (!document.execCommand("copy")) throw new Error("The browser did not copy the text.");
  } finally {
    area.remove();
    focused?.focus();
  }
}

export function ReferralDrafts({ referrals, company }: { referrals: Referrals; company: string }) {
  const headingId = useId();
  return (
    <section class="drawer-section" aria-labelledby={headingId}>
      <h3 class="drawer-heading" id={headingId}>
        Referral Drafts
      </h3>
      <p class="referral-intro">
        Ask a connection at {company} to refer you before you apply. Copy a draft and send it
        yourself.
      </p>
      <ul class="referrals">
        {referrals.drafts.map((draft) => (
          <li key={draft.name}>
            <Draft draft={draft} />
          </li>
        ))}
      </ul>
    </section>
  );
}

type Copy = "idle" | "copied" | "failed";

function Draft({ draft }: { draft: ReferralDraft }) {
  const nameId = useId();
  const [copy, setCopy] = useState<Copy>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = () => {
    clearTimeout(timer.current);
    copyText(draft.message).then(
      () => {
        setCopy("copied");
        timer.current = setTimeout(() => {
          setCopy("idle");
        }, COPIED_MS);
      },
      () => {
        setCopy("failed");
      },
    );
  };

  return (
    <article class="referral" aria-labelledby={nameId}>
      <header class="referral-header">
        <div class="referral-who">
          <h4 class="referral-name" id={nameId}>
            {draft.name}
          </h4>
          <p class="referral-role">
            {draft.position ? `${draft.position} at ${draft.company}` : draft.company}
          </p>
        </div>
        <button
          type="button"
          class={`referral-copy${copy === "copied" ? " is-copied" : ""}`}
          aria-label={`Copy message to ${draft.name}`}
          onClick={onCopy}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            {copy === "copied" ? (
              <path d="M3 8.5l3.25 3.25L13 5" />
            ) : (
              <>
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
              </>
            )}
          </svg>
          <span aria-hidden="true">{copy === "copied" ? "Copied" : "Copy message"}</span>
        </button>
      </header>
      <p class="referral-message">{draft.message}</p>
      {/* The button shows "Copied" itself, so only a failure needs words on screen. */}
      <p class={copy === "failed" ? "referral-status" : "visually-hidden"} role="status">
        {copy === "copied"
          ? "Copied"
          : copy === "failed"
            ? "Couldn't copy. Select the message and copy it yourself."
            : ""}
      </p>
      <a
        class="referral-search"
        href={linkedInSearchUrl(draft)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Find {draft.name} on LinkedIn<span aria-hidden="true"> ↗</span>
      </a>
    </article>
  );
}
