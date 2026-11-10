/**
 * The difference between two settings documents, in the words the Candidate reads. Tune shows it
 * before asking for approval, and the Settings panel counts it, so both describe a change the
 * same way.
 */
import {
  COMPANY_RULES,
  type CompanyRule,
  type ResumeVariant,
  type RoleType,
  type SearchProfile,
  type Seniority,
  type Settings,
} from "./settings.ts";

export type SettingsSection =
  | "queue"
  | "roleTypes"
  | "seniority"
  | "startWindow"
  | "locationTiers"
  | "companies"
  | "applySites"
  | "freshness"
  | "resumeVariants"
  | "other";

export interface SettingsChange {
  section: SettingsSection;
  text: string;
}

const SENIORITY_WORDS: Record<Seniority, string> = {
  intern: "intern",
  new_grad: "new grad",
  junior: "junior",
};

/** Fields every settings document has that are not the Candidate's choices. */
const BOOKKEEPING = new Set(["schemaVersion", "updatedAt"]);
const DESCRIBED = new Set([
  "searchProfile",
  "dailyQueueTarget",
  "companies",
  "blockedApplySites",
  "freshnessWeight",
  "resumeVariants",
]);
const SEARCH_PROFILE_FIELDS = new Set<string>([
  "roleTypes",
  "seniority",
  "startWindow",
  "locationTiers",
]);

const key = (name: string) => name.toLowerCase();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function roleTypeChanges(before: readonly RoleType[], after: readonly RoleType[]): string[] {
  const old = new Map(before.map((r) => [key(r.name), r]));
  const now = new Map(after.map((r) => [key(r.name), r]));
  const lines: string[] = [];
  for (const role of after) {
    if (!old.has(key(role.name))) lines.push(`added ${role.name} at ${role.priority} priority`);
  }
  for (const role of before) {
    if (!now.has(key(role.name))) lines.push(`removed ${role.name}`);
  }
  for (const role of after) {
    const was = old.get(key(role.name));
    if (was && was.priority !== role.priority)
      lines.push(`${role.name} from ${was.priority} to ${role.priority} priority`);
  }
  const kept = (list: readonly RoleType[], other: Map<string, RoleType>) =>
    list.filter((r) => other.has(key(r.name))).map((r) => key(r.name));
  if (!same(kept(before, now), kept(after, old)))
    lines.push(`order is now ${after.map((r) => r.name).join(", ")}`);
  return lines.map((line) => `Role types: ${line}`);
}

function startWindowText({ earliest, latest }: SearchProfile["startWindow"]): string {
  if (earliest && latest) return `${earliest} to ${latest}`;
  if (earliest) return `from ${earliest}`;
  if (latest) return `by ${latest}`;
  return "any time";
}

function locationChanges(
  before: SearchProfile["locationTiers"],
  after: SearchProfile["locationTiers"],
): string[] {
  const tierOf = (tiers: SearchProfile["locationTiers"]) => {
    const map = new Map<string, { name: string; tier: number }>();
    tiers.forEach((tier, index) => {
      for (const name of tier.locations) map.set(key(name), { name, tier: index + 1 });
    });
    return map;
  };
  const old = tierOf(before);
  const now = tierOf(after);
  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  for (const [id, { name, tier }] of now) {
    const was = old.get(id);
    if (!was) added.push(`added ${name} to Tier ${String(tier)}`);
    else if (was.tier !== tier)
      moved.push(`moved ${name} from Tier ${String(was.tier)} to Tier ${String(tier)}`);
  }
  for (const [id, { name, tier }] of old) {
    if (!now.has(id)) removed.push(`removed ${name} from Tier ${String(tier)}`);
  }
  return [...added, ...removed, ...moved].map((line) => `Location Tiers: ${line}`);
}

function companyChanges(before: Settings["companies"], after: Settings["companies"]): string[] {
  const ruleOf = (lists: Settings["companies"]) => {
    const map = new Map<string, { name: string; rule: CompanyRule }>();
    for (const rule of COMPANY_RULES)
      for (const name of lists[rule]) map.set(key(name), { name, rule });
    return map;
  };
  const old = ruleOf(before);
  const now = ruleOf(after);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [id, { name, rule }] of now) {
    const was = old.get(id);
    if (!was) added.push(`${rule} ${name}`);
    else if (was.rule !== rule) changed.push(`${name} from ${was.rule} to ${rule}`);
  }
  for (const [id, { name, rule }] of old) {
    if (!now.has(id)) removed.push(`no rule for ${name} (was ${rule})`);
  }
  return [...added, ...changed, ...removed].map((line) => `Companies: ${line}`);
}

function siteChanges(before: readonly string[], after: readonly string[]): string[] {
  return [
    ...after.filter((site) => !before.includes(site)).map((site) => `added ${site}`),
    ...before.filter((site) => !after.includes(site)).map((site) => `removed ${site}`),
  ].map((line) => `Blocked apply sites: ${line}`);
}

function variantChanges(
  before: readonly ResumeVariant[],
  after: readonly ResumeVariant[],
): string[] {
  const old = new Map(before.map((v) => [key(v.name), v]));
  const now = new Map(after.map((v) => [key(v.name), v]));
  const lines: string[] = [];
  for (const variant of after) if (!old.has(key(variant.name))) lines.push(`added ${variant.name}`);
  for (const variant of before)
    if (!now.has(key(variant.name))) lines.push(`removed ${variant.name}`);
  for (const variant of after) {
    const was = old.get(key(variant.name));
    if (was && !same([was.roleTypes, was.keywords], [variant.roleTypes, variant.keywords]))
      lines.push(`${variant.name} now picked by different rules`);
  }
  const kept = (list: readonly ResumeVariant[], other: Map<string, ResumeVariant>) =>
    list.filter((v) => other.has(key(v.name))).map((v) => key(v.name));
  if (!same(kept(before, now), kept(after, old)))
    lines.push(`order is now ${after.map((v) => v.name).join(", ")} (the first is the default)`);
  return lines.map((line) => `Resume Variants: ${line}`);
}

/** Every change from `before` to `after` that the Candidate would notice, in a fixed order. */
export function diffSettings(before: Settings, after: Settings): SettingsChange[] {
  const changes: SettingsChange[] = [];
  const add = (section: SettingsSection, texts: string[]) => {
    for (const text of texts) changes.push({ section, text });
  };
  const a = before.searchProfile;
  const b = after.searchProfile;

  if (before.dailyQueueTarget !== after.dailyQueueTarget)
    add("queue", [
      `Daily Queue target: ${String(before.dailyQueueTarget)} → ${String(after.dailyQueueTarget)}`,
    ]);
  add("roleTypes", roleTypeChanges(a.roleTypes, b.roleTypes));
  if (!same(a.seniority, b.seniority)) {
    const words = (levels: readonly Seniority[]) =>
      levels.map((level) => SENIORITY_WORDS[level]).join(", ");
    add("seniority", [`Seniority: ${words(a.seniority)} → ${words(b.seniority)}`]);
  }
  if (startWindowText(a.startWindow) !== startWindowText(b.startWindow))
    add("startWindow", [
      `Start window: ${startWindowText(a.startWindow)} → ${startWindowText(b.startWindow)}`,
    ]);
  add("locationTiers", locationChanges(a.locationTiers, b.locationTiers));
  add("companies", companyChanges(before.companies, after.companies));
  add("applySites", siteChanges(before.blockedApplySites, after.blockedApplySites));
  if (before.freshnessWeight !== after.freshnessWeight)
    add("freshness", [
      `Freshness weight: ${String(before.freshnessWeight)}% → ${String(after.freshnessWeight)}%`,
    ]);

  add("resumeVariants", variantChanges(before.resumeVariants, after.resumeVariants));

  // Fields this module does not know yet still show up, so no change goes unseen.
  const record = (s: Settings) => s as unknown as Record<string, unknown>;
  const profile = (s: Settings) => s.searchProfile as unknown as Record<string, unknown>;
  const names = (o: Record<string, unknown>) => Object.keys(o);
  const others = new Set([...names(record(before)), ...names(record(after))]);
  for (const field of [...others].sort()) {
    if (BOOKKEEPING.has(field) || DESCRIBED.has(field)) continue;
    if (!same(record(before)[field], record(after)[field])) add("other", [`${field} changed`]);
  }
  const profileFields = new Set([...names(profile(before)), ...names(profile(after))]);
  for (const field of [...profileFields].sort()) {
    if (SEARCH_PROFILE_FIELDS.has(field)) continue;
    if (!same(profile(before)[field], profile(after)[field]))
      add("other", [`searchProfile.${field} changed`]);
  }
  return changes;
}

/** The changes as a Markdown list, one per line, or "No changes." */
export function formatSettingsDiff(changes: readonly SettingsChange[]): string {
  if (changes.length === 0) return "No changes.";
  return changes.map((change) => `- ${change.text}`).join("\n");
}
