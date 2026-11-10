import { useEffect, useState } from "preact/hooks";
import {
  ADDED_BY_URL_SOURCE_ID,
  JOB_FEED_SOURCE_ID,
  SOURCES_COLLECTION,
  WATCHLIST_SOURCE_ID,
  readSourceSettings,
  validateSourceDocument,
  type AddedByUrlSource,
  type JobFeedSource,
  type SourceId,
  type SourceSettings,
  type WatchlistSource,
} from "../contract/index.ts";
import type { DashboardDb, DbError } from "./db.ts";

export type SourcesState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  /** `issues` lists Source documents outside the contract; their Sources read as off. */
  | { kind: "ready"; sources: SourceSettings; issues: string[] };

/** Subscribes once to the sources collection; missing documents read as their defaults. */
export function useSources(db: DashboardDb | null | undefined): SourcesState {
  const [state, setState] = useState<SourcesState>(
    db === null ? { kind: "unavailable" } : { kind: "loading" },
  );

  useEffect(() => {
    if (db === undefined) {
      setState({ kind: "loading" });
      return;
    }
    if (db === null) {
      setState({ kind: "unavailable" });
      return;
    }
    setState({ kind: "loading" });
    return db.collection(SOURCES_COLLECTION).onSnapshot(
      (snap) => {
        const { settings, issues } = readSourceSettings(
          snap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
        );
        setState({ kind: "ready", sources: settings, issues });
      },
      () => {
        setState({ kind: "failed" });
      },
    );
  }, [db]);

  return state;
}

type SourceDocument = JobFeedSource | WatchlistSource | AddedByUrlSource;

/** The whole Source document for one Source, from its settings, stamped `updatedAt`. */
export function sourceDocument(
  id: SourceId,
  sources: SourceSettings,
  updatedAt: string,
): SourceDocument {
  switch (id) {
    case JOB_FEED_SOURCE_ID:
      return { schemaVersion: 1, enabled: sources.jobFeed.enabled, updatedAt };
    case WATCHLIST_SOURCE_ID:
      return { schemaVersion: 1, ...sources.watchlist, updatedAt };
    case ADDED_BY_URL_SOURCE_ID:
      return { schemaVersion: 1, ...sources.addedByUrl, updatedAt };
  }
}

/** Why a save failed, in words the Candidate can act on. */
export function saveProblem(error: unknown): string {
  const { code, message } = (error ?? {}) as Partial<DbError>;
  if (code === "quota_exceeded" || code === "resource_exhausted") {
    return "Your dashboard storage is full, so this change wasn't saved.";
  }
  if (code === "invalid_argument" && message) {
    return `This change wasn't saved: ${message}`;
  }
  return "This change wasn't saved because your dashboard data can't be reached. Try again in a moment.";
}

/**
 * Writes one Source document whole, after checking it against the dashboard contract.
 * Resolves to undefined when saved, or to the problem to show the Candidate.
 */
export async function saveSource(
  db: DashboardDb,
  id: SourceId,
  sources: SourceSettings,
  updatedAt: string,
): Promise<string | undefined> {
  const document = sourceDocument(id, sources, updatedAt);
  const check = validateSourceDocument(id, document);
  if (!check.ok) return `This change wasn't saved: ${check.issues.join("; ")}`;
  try {
    await db.doc(`${SOURCES_COLLECTION}/${id}`).set({ ...document });
    return undefined;
  } catch (error) {
    return saveProblem(error);
  }
}
