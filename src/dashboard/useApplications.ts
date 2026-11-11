import { useCallback, useEffect, useState } from "preact/hooks";
import {
  APPLICATIONS_COLLECTION,
  validateApplicationDocument,
  type PreparedApplication,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";

export interface Applications {
  /** The Prepared Applications, by Posting id. Documents outside the contract are left out. */
  applications: ReadonlyMap<string, PreparedApplication>;
  /**
   * Saves the Candidate's change to a Prepared Application (an edit, a mode switch, their own
   * answer). Null when this view has no database. Rejects with the store's error, or when the
   * change would not match the contract.
   */
  save: ((next: PreparedApplication) => Promise<void>) | null;
}

const NONE: ReadonlyMap<string, PreparedApplication> = new Map();

/** Subscribes once to the Prepared Applications Refresh and Fill wrote. */
export function useApplications(db: DashboardDb | null | undefined): Applications {
  const [applications, setApplications] = useState(NONE);

  useEffect(() => {
    setApplications(NONE);
    if (!db) return;
    return db.collection(APPLICATIONS_COLLECTION).onSnapshot(
      (snap) => {
        const next = new Map<string, PreparedApplication>();
        for (const doc of snap.docs) {
          const result = validateApplicationDocument(doc.id, doc.data());
          if (result.ok) next.set(doc.id, result.value);
        }
        setApplications(next);
      },
      () => {
        // Without them the drawer shows no answers; the Job List reports outages.
        setApplications(NONE);
      },
    );
  }, [db]);

  const save = useCallback(
    async (next: PreparedApplication) => {
      if (!db) throw new Error("The dashboard database is not available.");
      const check = validateApplicationDocument(next.postingId, next);
      if (!check.ok) throw new Error(check.issues.join("; "));
      await db.collection(APPLICATIONS_COLLECTION).doc(next.postingId).set(check.value);
    },
    [db],
  );

  return { applications, save: db ? save : null };
}
