import { useEffect, useState } from "preact/hooks";
import {
  JOB_LIST_META_ID,
  POSTINGS_COLLECTION,
  jobListPageId,
  validatePostingsDocument,
  type JobListMeta,
  type JobListPage,
  type Posting,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";

export type JobListState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  /** No Refresh has written a Job List yet. */
  | { kind: "empty" }
  /** A Refresh is part way through writing; no complete Job List has been seen yet. */
  | { kind: "writing" }
  | { kind: "invalid"; issues: string[] }
  /** `updating` is true while a newer Refresh is still being written over this one. */
  | { kind: "ready"; meta: JobListMeta; postings: Posting[]; updating: boolean };

type Assembled =
  | { kind: "empty" }
  | { kind: "incomplete" }
  | { kind: "invalid"; issues: string[] }
  | { kind: "complete"; meta: JobListMeta; postings: Posting[] };

/** Puts the Job List back together from the meta document and its pages. */
function assemble(docs: readonly { id: string; data: unknown }[]): Assembled {
  const byId = new Map(docs.map((doc) => [doc.id, doc.data]));
  if (!byId.has(JOB_LIST_META_ID)) return { kind: "empty" };
  const metaResult = validatePostingsDocument(JOB_LIST_META_ID, byId.get(JOB_LIST_META_ID));
  if (!metaResult.ok) {
    return { kind: "invalid", issues: metaResult.issues.map((i) => `postings/meta: ${i}`) };
  }
  const meta = metaResult.value as JobListMeta;
  const postings: Posting[] = [];
  for (let page = 1; page <= meta.pageCount; page++) {
    const id = jobListPageId(page);
    if (!byId.has(id)) return { kind: "incomplete" };
    const result = validatePostingsDocument(id, byId.get(id));
    if (!result.ok) {
      // A page from an older Refresh may be mid-replacement; only a current one is a problem.
      const stamp = (byId.get(id) as { refreshedAt?: unknown } | undefined)?.refreshedAt;
      if (stamp !== meta.refreshedAt) return { kind: "incomplete" };
      return { kind: "invalid", issues: result.issues.map((i) => `postings/${id}: ${i}`) };
    }
    const data = result.value as JobListPage;
    if (data.refreshedAt !== meta.refreshedAt) return { kind: "incomplete" };
    postings.push(...data.postings);
  }
  return { kind: "complete", meta, postings };
}

/**
 * Subscribes once to the postings collection. A Refresh writes pages first and the meta
 * document last; until every page carries the meta document's `refreshedAt`, the last complete
 * Job List stays on screen.
 */
export function useJobList(db: DashboardDb | null | undefined): JobListState {
  const [state, setState] = useState<JobListState>(
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
    return db.collection(POSTINGS_COLLECTION).onSnapshot(
      (snap) => {
        const assembled = assemble(snap.docs.map((doc) => ({ id: doc.id, data: doc.data() })));
        setState((previous) => {
          switch (assembled.kind) {
            case "complete":
              return {
                kind: "ready",
                meta: assembled.meta,
                postings: assembled.postings,
                updating: false,
              };
            case "incomplete":
              return previous.kind === "ready"
                ? { ...previous, updating: true }
                : { kind: "writing" };
            case "empty":
              // An empty snapshot from the local cache can arrive before the server answers.
              return snap.metadata.fromCache && previous.kind === "loading"
                ? previous
                : { kind: "empty" };
            case "invalid":
              return assembled;
          }
        });
      },
      () => {
        setState({ kind: "failed" });
      },
    );
  }, [db]);

  return state;
}
