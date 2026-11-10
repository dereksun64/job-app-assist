import type { SearchProfile, Seniority } from "../contract/index.ts";

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
