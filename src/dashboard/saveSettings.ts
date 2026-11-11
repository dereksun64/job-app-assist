import {
  SETTINGS_COLLECTION,
  SETTINGS_DOC_ID,
  diffSettings,
  validateSettings,
  type SettingsChange,
  type Settings,
} from "../contract/index.ts";
import type { DashboardDb } from "./db.ts";
import { saveProblem } from "./saveProblem.ts";

export type SettingsSave = { ok: true; changes: SettingsChange[] } | { ok: false; problem: string };

/**
 * Writes the settings document whole with `change` applied to `current`, the latest document
 * the page has read, after checking it against the dashboard contract. Tune writes the same
 * document, so building on the latest read keeps its changes.
 */
export async function saveSettings(
  db: DashboardDb,
  current: Settings,
  change: (draft: Settings) => void,
  updatedAt: string,
): Promise<SettingsSave> {
  const draft = structuredClone(current);
  change(draft);
  draft.updatedAt = updatedAt;
  const changes = diffSettings(current, draft);
  if (changes.length === 0) return { ok: true, changes };
  const check = validateSettings(draft);
  if (!check.ok)
    return { ok: false, problem: `This change wasn't saved: ${check.issues.join("; ")}` };
  try {
    await db.doc(`${SETTINGS_COLLECTION}/${SETTINGS_DOC_ID}`).set({ ...check.value });
    return { ok: true, changes };
  } catch (error) {
    return { ok: false, problem: saveProblem(error) };
  }
}
