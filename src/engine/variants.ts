/**
 * Picking a Resume Variant for a Posting. Each of the Candidate's variants carries rules from
 * Setup (the role types it is made for and keywords that point to it); the pick weighs what the
 * Posting's title, role type and listing say against those rules and records why in plain words.
 * A pick is "confident" unless it was a close call or nothing pointed anywhere; the Refresh
 * skill reviews the unsure ones and may override them.
 */
import type { ResumeVariant, ResumeVariantPick } from "../contract/index.ts";
import { familiesOf } from "./roles.ts";

/** What a Posting says about itself, for picking a Resume Variant. */
export interface VariantEvidence {
  title: string;
  /** The Search Profile role type the Posting matched. */
  roleType: string;
  /** The Posting's description, when its Source gives one. */
  description?: string;
  /** The Source's own section or category, for example "AI/ML". */
  category?: string;
}

export interface VariantChoice {
  pick: ResumeVariantPick;
  /** False for a close call or a fallback to the default; Refresh reviews those. */
  confident: boolean;
}

/** A keyword in the title is the strongest sign, enough to beat the default's role type alone. */
const POINTS = { titleKeyword: 4, roleType: 2, family: 1, listingKeyword: 1 };
/** Listing keywords count up to this many, so a long description cannot outweigh the title. */
const MAX_LISTING_KEYWORDS = 3;
/** A winner needs this lead over the runner-up to be confident, unless it is the default. */
const CONFIDENT_LEAD = 2;
const SHOWN_KEYWORDS = 3;
const MAX_REASON = 300;

const FAMILY_LABELS: Record<string, string> = {
  software: "software",
  ml: "machine learning",
  data: "data",
  product: "product",
  program: "program management",
  quant: "quant",
  hardware: "hardware",
  security: "security",
};

interface Scored {
  variant: ResumeVariant;
  index: number;
  score: number;
  /** Plain-words evidence, strongest first. */
  evidence: string[];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `text` holds `keyword` as whole words: "ML" is not in "HTML", "C++" is in "C++ Developer",
 * and "full stack" is in "Full-Stack Engineer".
 */
function mentions(text: string, keyword: string): boolean {
  const words = keyword
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .map(escape);
  const phrase = words.join("[\\s-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}+#])`, "u").test(text);
}

function quoteList(words: readonly string[]): string {
  const quoted = words.slice(0, SHOWN_KEYWORDS).map((word) => `"${word}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1) ?? ""}`;
}

function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

function sentence(parts: readonly string[]): string {
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function fit(text: string): string {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1).trimEnd()}…`;
}

function score(
  variant: ResumeVariant,
  index: number,
  posting: VariantEvidence,
  title: string,
  listing: string,
  titleFamilies: ReadonlySet<string>,
): Scored {
  const evidence: string[] = [];
  let points = 0;
  const inTitle = variant.keywords.filter((keyword) => mentions(title, keyword));
  if (inTitle.length > 0) {
    points += POINTS.titleKeyword * inTitle.length;
    evidence.push(`the title mentions ${quoteList(inTitle)}`);
  }
  const roleType = posting.roleType.toLowerCase();
  if (variant.roleTypes.some((name) => name.toLowerCase() === roleType)) {
    points += POINTS.roleType;
    evidence.push(`made for ${posting.roleType} roles`);
  }
  const shared = [...familiesOf(variant.name)].filter((family) => titleFamilies.has(family));
  if (shared.length > 0) {
    points += POINTS.family;
    // A family says less than a keyword, so it is only worth saying when no keyword matched.
    if (inTitle.length === 0) {
      const labels = shared.map((family) => FAMILY_LABELS[family] ?? family);
      evidence.push(`the title reads as a ${nameList(labels)} role`);
    }
  }
  const inListing = variant.keywords.filter(
    (keyword) => !inTitle.includes(keyword) && mentions(listing, keyword),
  );
  if (inListing.length > 0) {
    points += POINTS.listingKeyword * Math.min(inListing.length, MAX_LISTING_KEYWORDS);
    evidence.push(`the listing mentions ${quoteList(inListing)}`);
  }
  return { variant, index, score: points, evidence };
}

/** Picks one of the Candidate's Resume Variants for a Posting, with the reason. */
export function pickResumeVariant(
  posting: VariantEvidence,
  variants: readonly ResumeVariant[],
): VariantChoice {
  const [fallback] = variants;
  if (!fallback) throw new Error("A Candidate has at least one Resume Variant.");
  if (variants.length === 1) {
    return { pick: { name: fallback.name, reason: "Your only Resume Variant." }, confident: true };
  }
  const title = posting.title.toLowerCase();
  const listing = [posting.category ?? "", posting.description ?? ""].join("\n").toLowerCase();
  const titleFamilies = familiesOf(posting.title);
  const ranked = variants
    .map((variant, index) => score(variant, index, posting, title, listing, titleFamilies))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const [best, second] = ranked;
  if (!best || best.score === 0) {
    return {
      pick: {
        name: fallback.name,
        reason: "Nothing in the title or listing points to a variant, so it uses your default.",
      },
      confident: false,
    };
  }
  const tied = ranked.filter((entry) => entry.score === best.score);
  if (tied.length > 1 && best.index === 0) {
    const names = nameList(tied.map((entry) => entry.variant.name));
    const [first = ""] = best.evidence;
    return {
      pick: {
        name: best.variant.name,
        reason: fit(
          `${sentence([first]).slice(0, -1)}, which fits ${names} equally; ${best.variant.name} is your default.`,
        ),
      },
      confident: true,
    };
  }
  const lead = best.score - (second?.score ?? 0);
  if (second && second.score > 0 && lead < CONFIDENT_LEAD) {
    const reason = `Close call between ${best.variant.name} and ${second.variant.name}: ${best.evidence.join("; ")}.`;
    return { pick: { name: best.variant.name, reason: fit(reason) }, confident: false };
  }
  return {
    pick: { name: best.variant.name, reason: fit(sentence(best.evidence)) },
    confident: true,
  };
}
