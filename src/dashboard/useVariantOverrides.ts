import { useCallback, useEffect, useState } from "preact/hooks";
import {
  VARIANT_OVERRIDES_COLLECTION,
  validateVariantOverrideDocument,
  type Posting,
  type VariantOverride,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";

export interface VariantOverrides {
  /** The Candidate's choices, by Posting id. Documents outside the contract are left out. */
  overrides: ReadonlyMap<string, VariantOverride>;
  /**
   * Records the Candidate's choice of Resume Variant for a Posting. Choosing Refresh's own pick
   * removes the override, so the Posting follows Refresh again. Rejects with the store's error.
   */
  choose: (posting: Posting, variant: string) => Promise<void>;
}

const NONE: ReadonlyMap<string, VariantOverride> = new Map();

/** Subscribes once to the Candidate's Resume Variant overrides. */
export function useVariantOverrides(
  db: DashboardDb | null | undefined,
  clock: () => number,
): VariantOverrides {
  const [overrides, setOverrides] = useState(NONE);

  useEffect(() => {
    setOverrides(NONE);
    if (!db) return;
    return db.collection(VARIANT_OVERRIDES_COLLECTION).onSnapshot(
      (snap) => {
        const next = new Map<string, VariantOverride>();
        for (const doc of snap.docs) {
          const result = validateVariantOverrideDocument(doc.id, doc.data());
          if (result.ok) next.set(doc.id, result.value);
        }
        setOverrides(next);
      },
      () => {
        // Without overrides every Posting shows Refresh's pick; the Job List reports outages.
        setOverrides(NONE);
      },
    );
  }, [db]);

  const choose = useCallback(
    async (posting: Posting, variant: string) => {
      if (!db) throw new Error("The dashboard database is not available.");
      const ref = db.collection(VARIANT_OVERRIDES_COLLECTION).doc(posting.id);
      if (variant === posting.resumeVariant.name) {
        await ref.delete();
        return;
      }
      const data: VariantOverride = {
        schemaVersion: 1,
        variant,
        chosenAt: new Date(clock()).toISOString(),
      };
      const check = validateVariantOverrideDocument(posting.id, data);
      if (!check.ok) throw new Error(check.issues.join("; "));
      await ref.set(data);
    },
    [db, clock],
  );

  return { overrides, choose };
}
