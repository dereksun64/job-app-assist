/**
 * Reading what a Posting is from its title: its seniority, which of the Candidate's role
 * types it fits, and when it starts. Titles are the most reliable signal Sources give;
 * a Source's job type and category are used only where the title says nothing.
 */
import type { RoleType, SearchProfile, Seniority } from "../contract/index.ts";
import { ROLE_TYPE_PRIORITIES } from "../contract/index.ts";

const INTERN = /\bintern(ship)?s?\b|\bco-?op\b|\bapprentice(ship)?\b/;
const NEW_GRAD =
  /\bnew (college )?grad(uate)?s?\b|\bgraduate\b|\buniversity\b|\bcollege\b|\bcampus\b|\bentry[- ]level\b|\bearly[- ]career\b|\bncg\b|\brotational\b|\bresidency\b/;
const JUNIOR =
  /\bjunior\b|\bjr\.?(?=\s|$)|\bassociate\b|\b(engineer|developer|scientist|sde|swe|analyst|programmer)\s+(i|1)\b/;
const SENIOR =
  /\bsenior\b|\bsr\.?(?=\s|$)|\bstaff (?!intern)(?=\w)|\bprincipal\b|\blead (engineer|developer|scientist|software|data|machine)|\b(engineer|developer|scientist|sde|swe|programmer),?\s+(ii|iii|iv|2|3|4)\b|\bdirector\b|\bhead of\b|\barchitect\b|\bexperienced\b|\bmid[- ]level\b|\bengineering manager\b|\bmanager,? (software|engineering)\b/;

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")} `;
}

/**
 * The seniority a Posting is pitched at, or undefined when it asks for more experience than
 * intern, new grad or junior. An explicit entry-level word in the title wins over the Source's
 * job type, so new-grad roles a Source lists as internships are read as new grad.
 *
 * A title that states no level reads as new grad, which suits Sources that list only
 * entry-level jobs. With `stated`, for Sources that list jobs at every level (a company's own
 * job board), only a level the title or job type states counts.
 */
export function levelOf(
  title: string,
  jobType: string,
  { stated = false }: { stated?: boolean } = {},
): Seniority | undefined {
  const text = normalize(title);
  if (INTERN.test(text)) return "intern";
  if (NEW_GRAD.test(text)) return "new_grad";
  if (JUNIOR.test(text)) return "junior";
  if (SENIOR.test(text)) return undefined;
  if (/intern/i.test(jobType)) return "intern";
  return stated ? undefined : "new_grad";
}

/** Role families, each recognized by words in a title or in a role type's name. */
const FAMILIES: Record<string, RegExp> = {
  software:
    /\bsoftware\b|\bswe\b|\bsdes?\b|\bdevelopers?\b|\bfull[- ]?stack\b|\bback[- ]?end\b|\bfront[- ]?end\b|\bmobile\b|\bios\b|\bandroid\b|\bweb\b|\bplatform engineer|\binfrastructure engineer|\bmember of technical staff\b|\bdevops\b|\bsite reliability\b|\bsre\b|\bcloud engineer|\bforward deployed\b|\bprogrammer\b|\bapplications? engineer|\bgeneralist\b/,
  ml: /\bmachine learning\b|\bml\b|\bai\b|\bartificial intelligence\b|\bdeep learning\b|\bllms?\b|\bnlp\b|\bcomputer vision\b|\bperception\b|\bapplied scientist\b|\bresearch scientist\b|\bresearch engineer\b/,
  data: /\bdata scien|\bdata engineer|\bdata analy|\banalytics\b|\bbusiness intelligence\b/,
  product: /\bproduct manag|\bapm\b|\bproduct owner\b/,
  program: /\bprogram manag|\btpm\b/,
  quant: /\bquant(itative)?\b|\btrader\b|\btrading\b/,
  hardware:
    /\bhardware\b|\basic\b|\bfpga\b|\belectrical engineer|\bembedded\b|\bfirmware\b|\bsilicon\b|\bsoc\b|\bvlsi\b|\brf\b|\bcircuit/,
  security: /\bsecurity\b|\bcyber|\bpenetration\b/,
};

/** Source categories (the Job Feed's sections) mapped to families, for titles that name no role. */
const CATEGORY_FAMILIES: [RegExp, string[]][] = [
  [/software/i, ["software"]],
  [/\bai\b|machine learning|data science/i, ["ml", "data"]],
  [/product/i, ["product"]],
  [/quant/i, ["quant"]],
  [/hardware/i, ["hardware"]],
];

/** The role families a title or a name belongs to, such as "software" or "ml". */
export function familiesOf(text: string): Set<string> {
  const normalized = normalize(text);
  return new Set(
    Object.entries(FAMILIES)
      .filter(([, re]) => re.test(normalized))
      .map(([family]) => family),
  );
}

const GENERIC_WORDS = new Set([
  "engineer",
  "engineering",
  "intern",
  "internship",
  "new",
  "grad",
  "graduate",
  "program",
  "role",
  "roles",
  "and",
  "or",
  "the",
  "of",
  "for",
  "in",
  "junior",
  "entry",
  "level",
]);

/** Title words that say nothing about the role, on top of the generic ones. */
const VAGUE_WORDS = new Set([
  "multiple",
  "teams",
  "team",
  "various",
  "general",
  "summer",
  "fall",
  "spring",
  "winter",
  "co",
  "op",
  "coop",
  "undergraduate",
  "masters",
  "phd",
  "starts",
  "start",
  "ii",
]);

function significantWords(name: string): string[] {
  return normalize(name)
    .replace(/\(.*?\)/g, " ")
    .split(/[^a-z0-9+#]+/)
    .filter((word) => word !== "" && !/^\d+$/.test(word) && !GENERIC_WORDS.has(word));
}

/** Word stems match, so "Robotics" in a role type finds "Robotics" and "Robotic" in titles. */
function hasWord(text: string, word: string): boolean {
  const stem = word.length > 5 ? word.slice(0, -2) : word;
  return new RegExp(`\\b${stem.replace(/[+#]/g, "\\$&")}`).test(text);
}

/**
 * The Candidate's role type a Posting fits best: the highest priority, then the earliest
 * listed, among role types that share a role family with the title. A role type outside
 * every family matches when all its significant words appear in the title.
 */
export function matchRoleType(
  title: string,
  category: string,
  roleTypes: readonly RoleType[],
): RoleType | undefined {
  let titleFamilies = familiesOf(title);
  // A title that names no role at all ("Graduate Intern", "Engineer 2 New Grad - Multiple
  // Teams") falls back to the Source's category; a title naming another role does not.
  if (titleFamilies.size === 0 && significantWords(title).every((word) => VAGUE_WORDS.has(word))) {
    titleFamilies = new Set(
      CATEGORY_FAMILIES.filter(([re]) => re.test(category)).flatMap(([, families]) => families),
    );
  }
  const text = normalize(title);
  const ordered = ROLE_TYPE_PRIORITIES.flatMap((priority) =>
    roleTypes.filter((roleType) => roleType.priority === priority),
  );
  return ordered.find((roleType) => {
    const families = familiesOf(roleType.name);
    if (families.size > 0) return [...families].some((family) => titleFamilies.has(family));
    const words = significantWords(roleType.name);
    return words.length > 0 && words.every((word) => hasWord(text, word));
  });
}

export interface StartWindow {
  from: string;
  to: string;
}

const SEASONS: Record<string, [string, string]> = {
  winter: ["01", "03"],
  spring: ["01", "05"],
  summer: ["05", "09"],
  fall: ["08", "12"],
  autumn: ["08", "12"],
};

/** When a Posting starts, as months, read from years and seasons in its title. */
export function startWindowOf(title: string): StartWindow | undefined {
  const text = title.toLowerCase();
  const years = [...text.matchAll(/(?<!\d)(20[2-4]\d)(?![\d])/g)].map((m) => Number(m[1]));
  if (years.length === 0) return undefined;
  const first = Math.min(...years);
  const last = Math.max(...years);
  if (first !== last) return { from: `${String(first)}-01`, to: `${String(last)}-12` };
  const seasons = [...text.matchAll(/\b(winter|spring|summer|fall|autumn)\b/g)]
    .map((m) => SEASONS[m[1] ?? ""])
    .filter((months) => months !== undefined);
  if (seasons.length === 0) return { from: `${String(first)}-01`, to: `${String(first)}-12` };
  const from = seasons.map(([start]) => start).sort()[0] ?? "01";
  const to =
    seasons
      .map(([, end]) => end)
      .sort()
      .at(-1) ?? "12";
  return { from: `${String(first)}-${from}`, to: `${String(first)}-${to}` };
}

/** Whether a Posting's start overlaps the Candidate's start window; unknown starts are kept. */
export function withinStartWindow(title: string, window: SearchProfile["startWindow"]): boolean {
  const start = startWindowOf(title);
  if (!start) return true;
  if (window.latest !== undefined && start.from > window.latest) return false;
  if (window.earliest !== undefined && start.to < window.earliest) return false;
  return true;
}
