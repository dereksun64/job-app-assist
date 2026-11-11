/**
 * The Progress tab: every card on a board with one column per Stage. The Candidate drags a card
 * to another column, or opens it in the shared detail drawer and changes its Stage there.
 * Moving a card to Closed first asks whether the Candidate was rejected or withdrew.
 * Once Fill has worked on a card, the card says how many fields to check (or that the site needs
 * a sign-in), and the drawer lists each flagged field with what to do.
 */
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import {
  POSSIBLY_CLOSED_DAYS,
  STAGES,
  compareQueueOrder,
  queueAgeDays,
  stageSince,
  type Card,
  type ClosedReason,
  type FillFlagKind,
  type FillRecord,
  type SimplifyResult,
  type Posting,
  type Stage,
} from "../contract/index.ts";
import { CLOSED_REASON_LABELS, STAGE_LABELS, count, formatMomentDay } from "./format.ts";
import { PostingDrawer } from "./PostingDrawer.tsx";
import type { ResumeVariantProps } from "./PostingsTab.tsx";
import { saveProblem, type QueueActions, type QueueState } from "./useQueue.ts";

export interface ProgressTabProps extends ResumeVariantProps {
  queue: QueueState;
  /** The Job List's Postings by id, once it has loaded; a card shows the listed Posting. */
  listed: ReadonlyMap<string, Posting> | undefined;
  /** Null when this view has no database to save moves to. */
  actions: QueueActions | null;
  now: number;
}

/** Queued cards in Queue order; later Stages with the latest move first. */
function columnOrder(stage: Stage): (a: Card, b: Card) => number {
  if (stage === "queued") return compareQueueOrder;
  return (a, b) =>
    stageSince(b).localeCompare(stageSince(a)) || a.postingId.localeCompare(b.postingId);
}

export function ProgressTab({
  queue,
  listed,
  actions,
  now,
  resumeVariants,
  overrides,
  onChooseVariant,
  referrals,
}: ProgressTabProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [closing, setClosing] = useState<Card | null>(null);
  const [problem, setProblem] = useState<string | undefined>();
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<Stage | null>(null);
  // Drop events can arrive before a re-render, so the dragged card is also kept in a ref.
  const draggingRef = useRef<string | null>(null);

  const cards = queue.kind === "ready" ? queue.cards : undefined;
  const columns = useMemo(() => {
    const byStage = new Map<Stage, Card[]>(STAGES.map((stage) => [stage, []]));
    for (const card of cards?.values() ?? []) byStage.get(card.stage)?.push(card);
    for (const [stage, list] of byStage) list.sort(columnOrder(stage));
    return byStage;
  }, [cards]);

  if (queue.kind === "failed") {
    return (
      <p class="notice notice-problem" role="alert">
        Your board stopped loading. Reload the page to try again.
      </p>
    );
  }
  if (queue.kind === "loading" || !cards) {
    return (
      <p class="notice notice-quiet" role="status">
        Loading your board…
      </p>
    );
  }

  const open = openId === null ? undefined : cards.get(openId);
  const postingOf = (card: Card) => listed?.get(card.postingId) ?? card.posting;

  const move = (card: Card, stage: Stage, closedReason?: ClosedReason) => {
    if (!actions) return;
    actions.move(card, stage, closedReason).then(
      () => {
        setProblem(undefined);
      },
      (error: unknown) => {
        setProblem(saveProblem(error));
      },
    );
  };
  /** Moves a card, first asking why when it moves to Closed. */
  const request = (card: Card, stage: Stage) => {
    if (stage === card.stage) return;
    if (stage === "closed") {
      setClosing(card);
      return;
    }
    move(card, stage);
  };

  const endDrag = () => {
    draggingRef.current = null;
    setDragging(null);
    setTarget(null);
  };

  return (
    <div class="progress">
      <p class="progress-hint">
        {cards.size === 0
          ? "Postings you queue appear here and move through each Stage as you apply."
          : actions
            ? "Drag a card to another column to change its Stage, or open it to change it there."
            : "Your board is read-only here, so cards can't be moved."}
      </p>
      {problem && (
        <p class="notice notice-problem" role="alert">
          {problem}
        </p>
      )}
      <section class="board" aria-label="Progress board">
        {STAGES.map((stage) => {
          const list = columns.get(stage) ?? [];
          return (
            <section
              key={stage}
              class={target === stage ? "board-column board-column-target" : "board-column"}
              aria-label={STAGE_LABELS[stage]}
              onDragEnter={(event) => {
                if (draggingRef.current === null) return;
                event.preventDefault();
                setTarget(stage);
              }}
              onDragOver={(event) => {
                if (draggingRef.current === null) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                if (target !== stage) setTarget(stage);
              }}
              onDragLeave={(event) => {
                const into = event.relatedTarget;
                if (into instanceof Node && event.currentTarget.contains(into)) return;
                setTarget((current) => (current === stage ? null : current));
              }}
              onDrop={(event) => {
                const id = draggingRef.current;
                if (id === null) return;
                event.preventDefault();
                const card = cards.get(id);
                endDrag();
                if (card) request(card, stage);
              }}
            >
              <h3 class="board-column-heading">
                <span class="board-column-name">{STAGE_LABELS[stage]}</span>
                <span class="board-count numeric">{list.length}</span>
              </h3>
              {list.length > 0 ? (
                <ul class="board-cards">
                  {list.map((card) => (
                    <BoardCard
                      key={card.postingId}
                      card={card}
                      posting={postingOf(card)}
                      unlisted={listed !== undefined && !listed.has(card.postingId)}
                      now={now}
                      draggable={actions !== null}
                      dragging={dragging === card.postingId}
                      onDragStart={(event) => {
                        draggingRef.current = card.postingId;
                        setDragging(card.postingId);
                        if (event.dataTransfer) {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", card.postingId);
                        }
                      }}
                      onDragEnd={endDrag}
                      onOpen={() => {
                        setOpenId(card.postingId);
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p class="board-empty">No cards</p>
              )}
            </section>
          );
        })}
      </section>

      {open && (
        <PostingDrawer
          posting={postingOf(open)}
          resumeVariants={resumeVariants}
          override={overrides.get(open.postingId)}
          onChooseVariant={(variant) => onChooseVariant(postingOf(open), variant)}
          referrals={referrals.get(open.postingId)}
          onClose={() => {
            setOpenId(null);
          }}
          now={now}
        >
          <StageSection
            card={open}
            canMove={actions !== null}
            problem={problem}
            onMove={(stage) => {
              request(open, stage);
            }}
          />
          {open.fill && <FillSection fill={open.fill} />}
        </PostingDrawer>
      )}

      {closing && (
        <ClosePrompt
          company={postingOf(closing).company}
          title={postingOf(closing).title}
          onChoose={(reason) => {
            setClosing(null);
            move(closing, "closed", reason);
          }}
          onCancel={() => {
            setClosing(null);
          }}
        />
      )}
    </div>
  );
}

interface BoardCardProps {
  card: Card;
  posting: Posting;
  unlisted: boolean;
  now: number;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}

function BoardCard({
  card,
  posting,
  unlisted,
  now,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: BoardCardProps) {
  const filling = card.fillingSince !== undefined;
  const flags: { text: string; warning?: boolean }[] = [];
  if (card.stage === "queued") {
    const age = queueAgeDays(card.queuedAt, now);
    if (unlisted) flags.push({ text: "No longer in your Job List", warning: true });
    if (age >= 1) flags.push({ text: `${count(age, "day")} in Queue` });
    if (age >= POSSIBLY_CLOSED_DAYS) flags.push({ text: "Possibly closed", warning: true });
  }
  if (card.fill && !filling) {
    const { outcome, flags: fillFlags } = card.fill;
    if (card.stage === "queued" && outcome === "needs_sign_in") {
      flags.push({ text: "Sign-in needed", warning: true });
    }
    if (card.stage === "queued" && outcome === "stopped") {
      flags.push({ text: "Fill stopped", warning: true });
    }
    if (card.stage === "ready_for_review" && outcome === "filled") {
      flags.push(
        fillFlags.length > 0
          ? { text: `${String(fillFlags.length)} to check`, warning: true }
          : { text: "Nothing flagged" },
      );
    }
  }
  if (card.stage === "closed" && card.closedReason) {
    flags.push({ text: CLOSED_REASON_LABELS[card.closedReason] });
  }
  const classes = ["board-card", dragging && "board-card-dragging", filling && "board-card-filling"]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      class={classes}
      draggable={draggable}
      aria-busy={filling || undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <button type="button" class="board-card-open" onClick={onOpen}>
        <span class="board-card-company">{posting.company}</span>
        <span class="board-card-title">{posting.title}</span>
      </button>
      {(filling || flags.length > 0) && (
        <div class="flags board-card-flags">
          {filling && (
            <span class="flag flag-filling">
              <span class="spinner" aria-hidden="true" />
              Filling
            </span>
          )}
          {flags.map(({ text, warning }) => (
            <span key={text} class={warning ? "flag flag-warning" : "flag"}>
              {text}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function StageSection({
  card,
  canMove,
  problem,
  onMove,
}: {
  card: Card;
  canMove: boolean;
  problem: string | undefined;
  onMove: (stage: Stage) => void;
}) {
  const headingId = useId();
  const selectId = useId();
  return (
    <section class="drawer-section" aria-labelledby={headingId}>
      <h3 class="drawer-heading" id={headingId}>
        Stage
      </h3>
      <div class="variant-choice">
        <label class="visually-hidden" for={selectId}>
          Stage
        </label>
        <select
          id={selectId}
          value={card.stage}
          disabled={!canMove}
          onChange={(event) => {
            onMove(event.currentTarget.value as Stage);
          }}
        >
          {STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
        <span class="variant-status">Since {formatMomentDay(stageSince(card))}</span>
      </div>
      {card.closedReason && (
        <p class="variant-reason">
          {card.closedReason === "rejected" ? "The company said no." : "You withdrew."}
        </p>
      )}
      {card.fillingSince !== undefined && (
        <p class="variant-reason stage-filling">
          <span class="spinner" aria-hidden="true" />
          Your Claude is filling this application now.
        </p>
      )}
      {problem && (
        <p class="variant-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

const FLAG_KIND_LABELS: Record<FillFlagKind, string> = {
  uncertain: "Not sure",
  legal_claim: "Claim about you",
  free_text: "Write it yourself",
  missing_answer: "Not in your private file",
  resume: "Resume",
  sign_in: "Sign-in",
  problem: "Problem",
};

const SIMPLIFY_LABELS: Record<SimplifyResult, string | undefined> = {
  filled: "Simplify filled the standard fields first, then your Claude checked every field.",
  absent: "Simplify did not appear, so your Claude filled every field.",
  failed: "Simplify's Autofill did not work, so your Claude filled every field.",
  not_tried: undefined,
};

/** What the last Fill did on the form, and each field it left for the Candidate. */
function FillSection({ fill }: { fill: FillRecord }) {
  const headingId = useId();
  const filled = fill.outcome === "filled";
  const summary = [
    `Filled ${formatMomentDay(fill.at)}.`,
    SIMPLIFY_LABELS[fill.simplify],
    fill.resumeVariant && `Uploaded ${fill.resumeVariant}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section class="drawer-section" aria-labelledby={headingId}>
      <h3 class="drawer-heading" id={headingId}>
        Flagged by Fill
      </h3>
      {filled && <p class="variant-reason">{summary}</p>}
      {fill.outcome === "needs_sign_in" && (
        <p class="variant-reason fill-stopped">
          This site needs you to sign in or create an account, which only you do. Your Claude
          stopped there on {formatMomentDay(fill.at)} and kept the card Queued.
        </p>
      )}
      {fill.outcome === "stopped" && (
        <p class="variant-reason fill-stopped">
          Your Claude could not fill this form on {formatMomentDay(fill.at)} and kept the card
          Queued.
        </p>
      )}
      {fill.flags.length > 0 && (
        <ul class="fill-flags">
          {fill.flags.map((flag, index) => (
            <li key={index} class="fill-flag">
              <span class="fill-flag-head">
                <span class="fill-flag-field">{flag.field}</span>
                <span class="flag fill-flag-kind">{FLAG_KIND_LABELS[flag.kind]}</span>
              </span>
              <span class="fill-flag-note">{flag.note}</span>
            </li>
          ))}
        </ul>
      )}
      {filled && (
        <p class="variant-reason">
          {fill.flags.length > 0
            ? "Check these in the application's tab in Helium, then submit it yourself."
            : "Nothing was flagged. Look the form over in its tab in Helium, then submit it yourself."}
        </p>
      )}
    </section>
  );
}

function ClosePrompt({
  company,
  title,
  onChoose,
  onCancel,
}: {
  company: string;
  title: string;
  onChoose: (reason: ClosedReason) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    first.current?.focus();
    return () => {
      if (element?.open) element.close();
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      class="close-prompt"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div class="close-prompt-panel">
        <h2 class="close-prompt-heading" id={headingId}>
          Why did {company} close?
        </h2>
        <p class="close-prompt-title">{title}</p>
        <div class="close-prompt-choices">
          <button
            ref={first}
            type="button"
            class="close-prompt-choice"
            onClick={() => {
              onChoose("rejected");
            }}
          >
            Rejected
          </button>
          <button
            type="button"
            class="close-prompt-choice"
            onClick={() => {
              onChoose("withdrawn");
            }}
          >
            I withdrew
          </button>
        </div>
        <button type="button" class="close-prompt-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
