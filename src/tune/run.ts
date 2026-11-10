/**
 * The Tune adapter: `jaa tune-report <dir>` and `jaa settings-diff <current> <proposed>`.
 *
 * `tune-report` reads the dashboard state the Tune skill saved under `<dir>/state` (ArtifactData
 * reads with `out_dir`): state/settings/main.json, state/skips/<doc-id>.json and
 * state/postings/<doc-id>.json. It prints the current settings, patterns in the Candidate's skip
 * reasons with the suggestions they back, and the companies and apply sites in the Job List, so
 * Tune can name real companies when it drafts a change.
 *
 * `settings-diff` checks a proposed settings document against the contract and prints exactly
 * what would change, the text Tune shows the Candidate before asking for approval. Neither
 * command writes anything.
 */
import { join } from "node:path";
import {
  POSTINGS_COLLECTION,
  SKIPS_COLLECTION,
  SKIP_REASONS,
  diffSettings,
  formatSettingsDiff,
  validatePostingsDocument,
  validateSettings,
  validateSkipDocument,
  type JobListMeta,
  type JobListPage,
  type Settings,
  type Skip,
  type SkipReason,
} from "../contract/index.ts";
import { applySiteOf } from "../engine/apply-sites.ts";
import { companyKey, companyRuleOf } from "../engine/companies.ts";
import { skipPatterns } from "../engine/skip-patterns.ts";

export interface TuneIo {
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  readStdin(): Promise<string>;
  now(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** How far back skip reasons count, so old habits stop steering suggestions. */
export const SKIP_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
/** How many Job List companies the report names. */
const COMPANY_LIMIT = 300;

const REASON_WORDS: Record<SkipReason, string> = {
  wrong_role: "wrong role",
  wrong_location: "wrong location",
  wrong_company: "wrong company",
  too_senior: "too senior",
  other: "other",
};
const RULE_WORDS = { boost: "boosted", lower: "lowered", block: "blocked" } as const;

class TuneError extends Error {}

async function readJsonFile(io: TuneIo, path: string): Promise<unknown> {
  let text: string;
  try {
    text = path === "-" ? await io.readStdin() : await io.readFile(path);
  } catch {
    throw new TuneError(`Could not read ${path}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TuneError(`${path} is not valid JSON.`);
  }
}

async function readSettingsFile(io: TuneIo, path: string, what: string): Promise<Settings> {
  const result = validateSettings(await readJsonFile(io, path));
  if (!result.ok) {
    throw new TuneError(
      `${what} does not match the dashboard contract:\n` +
        result.issues.map((issue) => `- ${issue}`).join("\n"),
    );
  }
  return result.value;
}

async function jsonFiles(io: TuneIo, folder: string): Promise<string[]> {
  return (await io.readDir(folder)).filter((name) => name.endsWith(".json")).sort();
}

async function readSkips(io: TuneIo, dir: string): Promise<Skip[]> {
  const folder = join(dir, "state", SKIPS_COLLECTION);
  const skips: Skip[] = [];
  for (const file of await jsonFiles(io, folder)) {
    const docId = file.slice(0, -".json".length);
    let body: unknown;
    try {
      body = JSON.parse(await io.readFile(join(folder, file))) as unknown;
    } catch {
      continue;
    }
    const result = validateSkipDocument(docId, body);
    if (result.ok) skips.push(result.value as Skip);
  }
  return skips;
}

async function readJobList(io: TuneIo, dir: string): Promise<JobListPage["postings"]> {
  const folder = join(dir, "state", POSTINGS_COLLECTION);
  let meta: JobListMeta | undefined;
  const pages: JobListPage[] = [];
  for (const file of await jsonFiles(io, folder)) {
    const docId = file.slice(0, -".json".length);
    let body: unknown;
    try {
      body = JSON.parse(await io.readFile(join(folder, file))) as unknown;
    } catch {
      continue;
    }
    const result = validatePostingsDocument(docId, body);
    if (!result.ok) continue;
    if (docId === "meta") meta = result.value as JobListMeta;
    else pages.push(result.value as JobListPage);
  }
  return pages
    .filter((page) => !meta || page.refreshedAt === meta.refreshedAt)
    .sort((a, b) => a.page - b.page)
    .flatMap((page) => page.postings);
}

const number = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

function settingsLine(settings: Settings): string {
  const { companies } = settings;
  return [
    `Settings now: daily Queue target ${String(settings.dailyQueueTarget)}`,
    `freshness weight ${String(settings.freshnessWeight)}%`,
    plural(settings.searchProfile.roleTypes.length, "role type"),
    plural(settings.searchProfile.locationTiers.length, "Location Tier"),
    `${number(companies.boost.length)} boosted, ${number(companies.lower.length)} lowered and ${number(companies.block.length)} blocked companies`,
    `${plural(settings.blockedApplySites.length, "blocked apply site")}.`,
  ].join("; ");
}

export function formatTuneReport(
  settings: Settings,
  skips: readonly Skip[],
  jobList: JobListPage["postings"],
  now: string,
): string {
  const since = new Date(Date.parse(now) - SKIP_WINDOW_DAYS * DAY_MS).toISOString();
  const patterns = skipPatterns(skips, settings, { since });
  const lines = [settingsLine(settings), ""];

  const reasons = SKIP_REASONS.filter((r) => patterns.byReason[r] > 0)
    .map((r) => `${REASON_WORDS[r]} ${number(patterns.byReason[r])}`)
    .join(", ");
  lines.push(
    patterns.total === 0
      ? `Skips: none in the last ${String(SKIP_WINDOW_DAYS)} days.`
      : `Skips: ${plural(patterns.total, "skip")} in the last ${String(SKIP_WINDOW_DAYS)} days (${reasons}).`,
  );
  if (patterns.total > 0) {
    lines.push("", "Suggestions from skip reasons:");
    if (patterns.suggestions.length === 0) lines.push("- none yet");
    for (const suggestion of patterns.suggestions) lines.push(`- ${suggestion.text}`);

    lines.push("", "Skipped companies, most skipped first:");
    for (const { company, skips: n, reasons: by } of patterns.companies) {
      const why = SKIP_REASONS.filter((r) => (by[r] ?? 0) > 0)
        .map((r) => `${REASON_WORDS[r]} ${number(by[r] ?? 0)}`)
        .join(", ");
      const rule = companyRuleOf(company, settings.companies);
      lines.push(`- ${company}: ${number(n)} (${why})${rule ? `; ${RULE_WORDS[rule]}` : ""}`);
    }
    const section = (title: string, entries: string[]) => {
      if (entries.length === 0) return;
      lines.push("", title);
      for (const entry of entries) lines.push(`- ${entry}`);
    };
    section(
      "Role types skipped as the wrong role:",
      patterns.roleTypes.map(
        (r) =>
          `${r.roleType}: ${number(r.skips)}${r.priority ? ` (${r.priority} priority)` : " (no longer in the Search Profile)"}`,
      ),
    );
    section(
      "Locations skipped as the wrong location:",
      patterns.locations.map(
        (l) => `${l.location} (Tier ${String(l.locationTier)}): ${number(l.skips)}`,
      ),
    );
    section(
      "Seniorities skipped as too senior:",
      patterns.levels.map((l) => `${l.level}: ${number(l.skips)}`),
    );
    section(
      "Apply sites of skipped Postings:",
      patterns.applySites.map((s) => `${s.site}: ${number(s.skips)}`),
    );
  }

  lines.push("");
  if (jobList.length === 0) {
    lines.push("Job List: empty, so there are no companies to name yet.");
  } else {
    const companies = new Map<string, { name: string; count: number }>();
    const sites = new Map<string, number>();
    for (const posting of jobList) {
      const key = companyKey(posting.company) || posting.company;
      const entry = companies.get(key) ?? { name: posting.company, count: 0 };
      entry.count += 1;
      companies.set(key, entry);
      const site = applySiteOf(posting.applyUrl);
      if (site !== undefined) sites.set(site, (sites.get(site) ?? 0) + 1);
    }
    const ranked = [...companies.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
    lines.push(
      `Job List companies (${plural(jobList.length, "Posting")} at ${plural(ranked.length, "company", "companies")}, most Postings first${ranked.length > COMPANY_LIMIT ? `, first ${String(COMPANY_LIMIT)}` : ""}):`,
    );
    lines.push(
      ranked
        .slice(0, COMPANY_LIMIT)
        .map(({ name, count }) => {
          const rule = companyRuleOf(name, settings.companies);
          return `${name} ${number(count)}${rule ? ` (${RULE_WORDS[rule]})` : ""}`;
        })
        .join("; "),
    );
    lines.push(
      "",
      "Job List apply sites:",
      [...sites]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([site, n]) => `${site} ${number(n)}`)
        .join("; "),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runTuneReport(dir: string, io: TuneIo): Promise<number> {
  try {
    const settings = await readSettingsFile(
      io,
      join(dir, "state", "settings", "main.json"),
      "The saved settings document",
    );
    const [skips, jobList] = await Promise.all([readSkips(io, dir), readJobList(io, dir)]);
    io.stdout(formatTuneReport(settings, skips, jobList, io.now()));
    return 0;
  } catch (error) {
    if (!(error instanceof TuneError)) throw error;
    io.stderr(`${error.message}\n`);
    return 1;
  }
}

export async function runSettingsDiff(
  currentPath: string,
  proposedPath: string,
  io: TuneIo,
): Promise<number> {
  try {
    const current = await readSettingsFile(io, currentPath, "The current settings document");
    const proposed = await readSettingsFile(io, proposedPath, "The proposed settings document");
    const changes = diffSettings(current, proposed);
    io.stdout(
      changes.length === 0
        ? "No changes: the proposed settings match the current ones.\n"
        : `${plural(changes.length, "change")} to your settings:\n${formatSettingsDiff(changes)}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof TuneError)) throw error;
    io.stderr(`${error.message}\n`);
    return 1;
  }
}
