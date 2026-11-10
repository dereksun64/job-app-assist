import type { SearchProfile, Seniority, SkipReason, Stage } from "../contract/index.ts";

export const STAGE_LABELS: Record<Stage, string> = {
  queued: "Queued",
  ready_for_review: "Ready for Review",
  submitted: "Submitted",
  interviewing: "Interviewing",
  offer: "Offer",
  closed: "Closed",
};

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  wrong_role: "Wrong role",
  wrong_location: "Wrong location",
  wrong_company: "Wrong company",
  too_senior: "Too senior",
  other: "Other reason",
};

const SENIORITY_LABELS: Record<Seniority, string> = {
  intern: "Intern",
  new_grad: "New grad",
  junior: "Junior",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatSeniority(levels: readonly Seniority[]): string {
  return levels.map((level) => SENIORITY_LABELS[level]).join(", ");
}

/** `2027-01` as `Jan 2027`. */
export function formatMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-");
  return `${MONTHS[Number(month) - 1] ?? month ?? ""} ${year ?? ""}`;
}

export function formatStartWindow({ earliest, latest }: SearchProfile["startWindow"]): string {
  if (earliest && latest) return `${formatMonth(earliest)} to ${formatMonth(latest)}`;
  if (earliest) return `From ${formatMonth(earliest)}`;
  if (latest) return `By ${formatMonth(latest)}`;
  return "Any time";
}

/** One seniority, as a short label. */
export function formatLevel(level: Seniority): string {
  return SENIORITY_LABELS[level];
}

/** A moment as "Nov 10, 3:04 PM" in the viewer's own time zone. */
export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const DAY_MS = 86_400_000;

/** Whole days from a posted day (YYYY-MM-DD, in UTC) to now. */
export function daysSincePosted(postedOn: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(`${postedOn}T00:00:00Z`)) / DAY_MS));
}

/** How long ago a Posting went up: "Today", "Yesterday", "3 days ago", "2 weeks ago", "3 months ago". */
export function formatPostedAge(postedOn: string, now: number): string {
  const days = daysSincePosted(postedOn, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${String(days)} days ago`;
  if (days < 60) return `${String(Math.floor(days / 7))} weeks ago`;
  return `${String(Math.floor(days / 30))} months ago`;
}

/** A day (YYYY-MM-DD) as "Tuesday, November 10, 2026". Days carry no time zone. */
export function formatDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A day (YYYY-MM-DD) as "Tue, Nov 10". */
export function formatShortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A day (YYYY-MM-DD) as "Nov 9", with the year only when it is not the year of `now`. */
export function formatDate(day: string, now: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
