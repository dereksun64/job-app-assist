import { useEffect, useState } from "preact/hooks";
import { NEWS_COLLECTION, validateNewsDocument, type NewsDigest } from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";

export type NewsState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "empty" }
  /** Every digest in the collection broke the contract. */
  | { kind: "invalid" }
  /** Digests newest first; documents that break the contract are left out. */
  | { kind: "ready"; digests: readonly NewsDigest[] };

/** Subscribes to the news collection, one News Digest per day. */
export function useNews(db: DashboardDb | null | undefined): NewsState {
  const [state, setState] = useState<NewsState>({ kind: "loading" });

  useEffect(() => {
    setState({ kind: "loading" });
    if (!db) return;
    return db.collection(NEWS_COLLECTION).onSnapshot(
      (snap) => {
        const digests = snap.docs
          .map((doc) => validateNewsDocument(doc.id, doc.data()))
          .flatMap((result) => (result.ok ? [result.value as NewsDigest] : []))
          .sort((a, b) => b.day.localeCompare(a.day));
        setState(
          digests.length > 0
            ? { kind: "ready", digests }
            : snap.empty
              ? { kind: "empty" }
              : { kind: "invalid" },
        );
      },
      () => {
        setState({ kind: "failed" });
      },
    );
  }, [db]);

  return state;
}
