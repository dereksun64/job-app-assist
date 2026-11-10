/** Posting dates and freshness. */

const DAY_MS = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const UNIT_DAYS: Record<string, number> = { h: 1 / 24, d: 1, w: 7, mo: 30, y: 365 };

export function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The day a Posting was posted, from a Source's age ("0d", "3w", "1mo") or date ("Aug 12")
 * counted back from when the Source's data was generated. An unreadable age counts as that day.
 */
export function postedOnFrom(age: string, generatedAt: string): string {
  const reference = Date.parse(generatedAt);
  const text = age.trim().toLowerCase();
  const relative = /^(\d+)\s*(h|d|w|mo|y)$/.exec(text);
  if (relative) {
    const days = Number(relative[1]) * (UNIT_DAYS[relative[2] ?? "d"] ?? 1);
    return isoDay(reference - Math.floor(days) * DAY_MS);
  }
  const absolute = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/.exec(text);
  const month = absolute ? MONTHS.indexOf(absolute[1] ?? "") : -1;
  if (absolute && month !== -1) {
    const now = new Date(reference);
    let year = now.getUTCFullYear();
    let date = Date.UTC(year, month, Number(absolute[2]));
    // "Dec 30" read in January means last December.
    if (date > reference) {
      year -= 1;
      date = Date.UTC(year, month, Number(absolute[2]));
    }
    return isoDay(date);
  }
  return isoDay(reference);
}

/** Whole days from a posted day to a moment, never negative. */
export function daysSince(postedOn: string, now: string): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(`${postedOn}T00:00:00Z`)) / DAY_MS));
}

/** Freshness from 1 (posted today) halving every two weeks. */
export function freshness(postedOn: string, now: string): number {
  return 0.5 ** (daysSince(postedOn, now) / 14);
}
