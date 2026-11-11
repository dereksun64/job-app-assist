import { useEffect, useState } from "preact/hooks";
import {
  CARDS_COLLECTION,
  SKIPS_COLLECTION,
  moveCard,
  validateCardDocument,
  validateSkipDocument,
  type Card,
  type ClosedReason,
  type Posting,
  type Skip,
  type SkipReason,
  type Stage,
  type Validation,
} from "../contract/index.ts";
import type { DashboardDb, QuerySnapshot } from "./db.ts";

export type QueueState =
  | { kind: "loading" }
  | { kind: "failed" }
  /** Cards and skips by Posting id; documents that break the contract are left out. */
  | { kind: "ready"; cards: ReadonlyMap<string, Card>; skips: ReadonlyMap<string, Skip> };

function byPostingId<T extends { postingId: string }>(
  snap: QuerySnapshot,
  validate: (docId: string, input: unknown) => Validation<unknown>,
): Map<string, T> {
  const docs = new Map<string, T>();
  for (const doc of snap.docs) {
    const result = validate(doc.id, doc.data());
    if (result.ok) docs.set(doc.id, result.value as T);
  }
  return docs;
}

/** Subscribes to the cards and skips collections; the Queue is ready once both have answered. */
export function useQueue(db: DashboardDb | null | undefined): QueueState {
  const [cards, setCards] = useState<Map<string, Card> | undefined>();
  const [skips, setSkips] = useState<Map<string, Skip> | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCards(undefined);
    setSkips(undefined);
    setFailed(false);
    if (!db) return;
    const fail = () => {
      setFailed(true);
    };
    const stopCards = db.collection(CARDS_COLLECTION).onSnapshot((snap) => {
      setCards(byPostingId<Card>(snap, validateCardDocument));
    }, fail);
    const stopSkips = db.collection(SKIPS_COLLECTION).onSnapshot((snap) => {
      setSkips(byPostingId<Skip>(snap, validateSkipDocument));
    }, fail);
    return () => {
      stopCards();
      stopSkips();
    };
  }, [db]);

  if (failed) return { kind: "failed" };
  if (!cards || !skips) return { kind: "loading" };
  return { kind: "ready", cards, skips };
}

/** The Candidate's own Queue and board changes. Each resolves once the store accepts its writes. */
export interface QueueActions {
  /** Puts a Posting in the Queue, lifting its skip when `skipped` says it has one. */
  tick(posting: Posting, skipped: boolean): Promise<void>;
  /** Takes a Posting out of the Queue and records why. */
  skip(posting: Posting, reason: SkipReason): Promise<void>;
  /** Lifts a skip, so the Posting is back in the Job List, unqueued. */
  unskip(postingId: string): Promise<void>;
  /** Moves a card to another Stage; Closed needs the reason. */
  move(card: Card, stage: Stage, closedReason?: ClosedReason): Promise<void>;
}

/**
 * Writes go one at a time, so each action orders them to fail safely: the new document first,
 * then the removal. If the second write fails, the Posting is both queued and skipped, which the
 * page shows as queued and the Candidate can simply retry.
 */
export function queueActions(db: DashboardDb, clock: () => number): QueueActions {
  const stamp = () => new Date(clock()).toISOString();
  return {
    async tick(posting, skipped) {
      const now = stamp();
      const card: Card = {
        schemaVersion: 1,
        postingId: posting.id,
        stage: "queued",
        queuedAt: now,
        queuedBy: "candidate",
        posting,
        updatedAt: now,
      };
      await db
        .collection(CARDS_COLLECTION)
        .doc(posting.id)
        .set(checked(CARDS_COLLECTION, validateCardDocument, card));
      if (skipped) await db.collection(SKIPS_COLLECTION).doc(posting.id).delete();
    },
    async skip(posting, reason) {
      const skip: Skip = {
        schemaVersion: 1,
        postingId: posting.id,
        reason,
        skippedAt: stamp(),
        posting,
      };
      await db
        .collection(SKIPS_COLLECTION)
        .doc(posting.id)
        .set(checked(SKIPS_COLLECTION, validateSkipDocument, skip));
      await db.collection(CARDS_COLLECTION).doc(posting.id).delete();
    },
    async unskip(postingId) {
      await db.collection(SKIPS_COLLECTION).doc(postingId).delete();
    },
    async move(card, stage, closedReason) {
      const moved = moveCard(card, stage, stamp(), closedReason);
      await db
        .collection(CARDS_COLLECTION)
        .doc(card.postingId)
        .set(checked(CARDS_COLLECTION, validateCardDocument, moved));
    },
  };
}

/** Checks a document the page built against the contract before it is written. */
function checked<T extends Card | Skip>(
  collection: string,
  validate: (docId: string, input: unknown) => Validation<unknown>,
  data: T,
): T {
  const result = validate(data.postingId, data);
  if (!result.ok) {
    throw new Error(
      `The page built an invalid ${collection} document: ${result.issues.join("; ")}`,
    );
  }
  return data;
}
