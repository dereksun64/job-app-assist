import { useEffect, useState } from "preact/hooks";
import {
  REFERRALS_COLLECTION,
  validateReferralsDocument,
  type Referrals,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";

const NONE: ReadonlyMap<string, Referrals> = new Map();

/**
 * Subscribes to the Referral Drafts Refresh wrote, by Posting id. Documents outside the contract
 * are left out, and an outage shows no drafts: the Job List reports outages.
 */
export function useReferrals(db: DashboardDb | null | undefined): ReadonlyMap<string, Referrals> {
  const [referrals, setReferrals] = useState(NONE);

  useEffect(() => {
    setReferrals(NONE);
    if (!db) return;
    return db.collection(REFERRALS_COLLECTION).onSnapshot(
      (snap) => {
        const next = new Map<string, Referrals>();
        for (const doc of snap.docs) {
          const result = validateReferralsDocument(doc.id, doc.data());
          if (result.ok) next.set(doc.id, result.value);
        }
        setReferrals(next);
      },
      () => {
        setReferrals(NONE);
      },
    );
  }, [db]);

  return referrals;
}
