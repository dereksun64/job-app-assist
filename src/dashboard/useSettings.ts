import { useEffect, useState } from "preact/hooks";
import {
  SETTINGS_COLLECTION,
  SETTINGS_DOC_ID,
  validateSettings,
  type Settings,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";

/** How long the page waits for the store before saying the data can't be reached yet. */
export const LOADING_TIMEOUT_MS = 10_000;

export type SettingsState =
  | { kind: "connecting" }
  | { kind: "loading"; slow: boolean }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "missing" }
  | { kind: "invalid"; issues: string[] }
  | { kind: "ready"; settings: Settings };

/**
 * Subscribes once to the settings document and checks it against the dashboard contract.
 * `db` is undefined while the capability is still resolving and null when this view has none.
 */
export function useSettings(db: DashboardDb | null | undefined): SettingsState {
  const [state, setState] = useState<SettingsState>(
    db === undefined ? { kind: "connecting" } : { kind: "loading", slow: false },
  );

  useEffect(() => {
    if (db === undefined) {
      setState({ kind: "connecting" });
      return;
    }
    if (db === null) {
      setState({ kind: "unavailable" });
      return;
    }
    setState({ kind: "loading", slow: false });
    let answered = false;
    const timer = setTimeout(() => {
      setState((current) =>
        current.kind === "loading" ? { kind: "loading", slow: true } : current,
      );
    }, LOADING_TIMEOUT_MS);
    const unsubscribe = db.doc(`${SETTINGS_COLLECTION}/${SETTINGS_DOC_ID}`).onSnapshot(
      (snap) => {
        if (!snap.metadata.fromCache && !answered) {
          answered = true;
          clearTimeout(timer);
        }
        if (!snap.exists) {
          if (answered) setState({ kind: "missing" });
          return;
        }
        const result = validateSettings(snap.data());
        setState(
          result.ok
            ? { kind: "ready", settings: result.value }
            : { kind: "invalid", issues: result.issues },
        );
      },
      () => {
        clearTimeout(timer);
        setState({ kind: "failed" });
      },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [db]);

  return state;
}
