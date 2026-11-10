/**
 * The Refresh engine core: Source Postings, the settings document, the current Job List and the
 * Queue in; the new Job List, the Postings it pre-queued, a change set of dashboard writes and a
 * summary out. It is deterministic and
 * makes no network or Claude calls: fetching Sources and resolving short links happen in the
 * adapter (src/refresh/), which hands this module plain data.
 */
import {
  ADDED_BY_URL_SOURCE,
  JOB_FEED_SOURCE,
  CARDS_COLLECTION,
  JOB_LIST_META_ID,
  WATCHLIST_SOURCE,
  defaultSourceSettings,
  MAX_JOB_LIST,
  POSTING_DESCRIPTION_MAX,
  POSTINGS_COLLECTION,
  POSTINGS_PER_PAGE,
  REFERRALS_COLLECTION,
  jobListPageId,
  type Card,
  type JobListMeta,
  type JobListPage,
  type Posting,
  type PostingSource,
  type Referrals,
  type RoleTypePriority,
  type Seniority,
  type Settings,
  type SourceReport,
  type SourceSettings,
} from "../contract/index.ts";
import { onBlockedSite } from "./apply-sites.ts";
import {
  companyBoost,
  companyKey,
  companyKnown,
  companyRuleOf,
  displayCompany,
  UNKNOWN_COMPANY,
} from "./companies.ts";
import { freshness, isoDay, postedOnFrom } from "./freshness.ts";
import { locationTierOf, parseLocations, unmatchedTierLocations, type Place } from "./locations.ts";
import { planQueue, type CurrentQueue, type QueueSummary } from "./queue.ts";
import {
  planReferrals,
  type Connection,
  type ReferralCall,
  type ReferralCalls,
  type ReferralReviewCompany,
  type ReferralSummary,
} from "./referrals.ts";
import { levelOf, matchRoleType, withinStartWindow } from "./roles.ts";
import type { SourcePosting, SourceResult } from "./source.ts";
import { canonicalApplyUrl, isShortLink, postingId } from "./urls.ts";
import { pickResumeVariant, type VariantEvidence } from "./variants.ts";

/** The Job List as the dashboard database holds it now. */
export interface CurrentJobList {
  meta?: JobListMeta;
  pages: readonly JobListPage[];
}

export interface RefreshInput {
  /** When this Refresh runs, as an ISO timestamp; it stamps every document written. */
  now: string;
  settings: Settings;
  /**
   * The Candidate's Sources: their switches, the watchlist and the Postings added by URL.
   * Every Source is on with nothing added when this is left out.
   */
  sourceSettings?: SourceSettings;
  /** What the adapter read: the Job Feed and each watchlist company's job board. */
  sources: readonly SourceResult[];
  current: CurrentJobList;
  /** The Queue and skips as the dashboard database holds them now. */
  queue: CurrentQueue;
  /** Where each short link leads, from the adapter. Unresolved links stay as they are. */
  resolvedLinks?: Readonly<Record<string, string>>;
  /** The Refresh skill's calls on unsure Resume Variant picks, by Posting id. */
  variantJudgments?: Readonly<Record<string, VariantJudgment>>;
  /** The Candidate's imported connections; undefined when they have not imported any. */
  connections?: readonly Connection[];
  /** The Referral Drafts as the dashboard database holds them now. */
  referrals?: CurrentReferrals;
  /** The Refresh skill's drafted messages and skipped matches, by Posting id. */
  referralCalls?: ReferralCalls;
}

/** The referrals documents the dashboard database holds now. */
export interface CurrentReferrals {
  /** The readable documents, by Posting id. */
  docs: ReadonlyMap<string, Referrals>;
  /** Every document id, readable or not. */
  ids: readonly string[];
}

/** The Refresh skill's call on one unsure Resume Variant pick. */
export interface VariantJudgment {
  variant: string;
  reason: string;
}

/** The longest reason a judgment may give; "Reviewed: " is added before it. */
export const MAX_JUDGMENT_REASON = 280;

/** The most unsure Resume Variant picks one Refresh asks the Refresh skill to review. */
export const MAX_VARIANT_REVIEW = 25;

/** An unsure Resume Variant pick, for the Refresh skill to review. */
export interface VariantReviewItem {
  id: string;
  company: string;
  title: string;
  roleType: string;
  applyUrl: string;
  picked: string;
  reason: string;
}

export interface ChangeSet {
  /**
   * Documents to write whole: Job List pages, then the meta document, then new Queue cards,
   * then Referral Drafts.
   */
  set: { collection: string; docId: string; data: JobListPage | JobListMeta | Card | Referrals }[];
  /** Documents to remove. */
  delete: { collection: string; docId: string }[];
}

/** Source Postings left out, by why. The last two count merged Postings, not listings. */
export interface FilteredOut {
  location: number;
  seniority: number;
  startWindow: number;
  roleType: number;
  /** Postings at a company the Candidate blocked. */
  company: number;
  /** Postings whose every apply URL is on a site the Candidate blocked. */
  applySite: number;
}

/** A Posting the Candidate added by URL that the Job List left out, and why. */
export interface AddedLeftOut {
  url: string;
  company: string;
  title: string;
  reason: keyof FilteredOut;
}

export interface RefreshSummary {
  refreshedAt: string;
  /** Postings in the new Job List. */
  total: number;
  /** Postings that matched the Search Profile, before the Job List limit. */
  matched: number;
  newPostings: number;
  removedPostings: number;
  /** Postings per Location Tier, Tier 1 first. */
  byTier: number[];
  sources: SourceReport[];
  filteredOut: FilteredOut;
  /** Short links that could not be resolved and stay as the apply URL. */
  unresolvedLinks: number;
  /** Postings kept from the last Refresh because their Source failed this time. */
  carriedOver: number;
  /** Location Tier entries that matched no location in any Source. */
  unmatchedLocations: string[];
  /** Postings per Resume Variant, in the Candidate's order. */
  byVariant: Record<string, number>;
  /** Unsure picks with no judgment yet: how many, and the best-ranked of them to review. */
  variantReview: { unsure: number; postings: VariantReviewItem[] };
  /** Postings added by URL that do not match the Search Profile. */
  addedLeftOut: AddedLeftOut[];
  top: Pick<Posting, "company" | "title" | "locations" | "locationTier" | "score" | "applyUrl">[];
  queue: QueueSummary;
  referrals: ReferralSummary;
}

export interface RefreshResult {
  jobList: Posting[];
  meta: JobListMeta;
  /** The cards this Refresh pre-queued, in Queue order. */
  preQueued: Card[];
  changeSet: ChangeSet;
  summary: RefreshSummary;
  /** Matches with no Referral Draft yet, by company, best-ranked first, for the Refresh skill. */
  referralReview: ReferralReviewCompany[];
  /** The Refresh skill's referral calls that still apply, to keep for the next Refresh. */
  referralCalls: Record<string, Record<string, ReferralCall>>;
}

/** A Source Posting that matched the Search Profile, before dedupe. */
interface Candidate {
  order: number;
  listing: SourcePosting;
  source: PostingSource;
  rawUrl: string;
  canonicalUrl: string;
  /** The listing's URL is a short link that could not be resolved. */
  unresolved: boolean;
  places: Place[];
  locationTier: number;
  level: Seniority;
  roleType: string;
  priority: RoleTypePriority;
  postedOn: string;
}

const FIT: Record<RoleTypePriority, number> = { high: 1, medium: 0.6, low: 0.25 };

/**
 * A Posting's score, 0 to 100: freshness counts for the Candidate's freshness weight, and role
 * type priority fit and company boost share the rest, five parts to three.
 */
function score(
  priority: RoleTypePriority,
  boost: number,
  postedOn: string,
  now: string,
  settings: Settings,
): number {
  const freshnessWeight = settings.freshnessWeight / 100;
  const rest = 1 - freshnessWeight;
  const value =
    ((rest * 5) / 8) * FIT[priority] +
    ((rest * 3) / 8) * boost +
    freshnessWeight * freshness(postedOn, now);
  return Math.min(100, Math.max(0, Math.round(100 * value)));
}

type Evaluation =
  | { candidate: Omit<Candidate, "order" | "rawUrl" | "canonicalUrl" | "unresolved"> }
  | { reason: keyof FilteredOut };

function evaluate(
  listing: SourcePosting,
  result: { name: string; list?: string; listsEveryLevel?: boolean },
  generatedAt: string,
  settings: Settings,
  places: Place[],
): Evaluation {
  const { searchProfile } = settings;
  const locationTier = locationTierOf(places, searchProfile.locationTiers);
  if (locationTier === undefined) return { reason: "location" };
  const level = levelOf(listing.title, listing.jobType, {
    stated: result.listsEveryLevel === true,
  });
  if (level === undefined || !searchProfile.seniority.includes(level))
    return { reason: "seniority" };
  if (!withinStartWindow(listing.title, searchProfile.startWindow))
    return { reason: "startWindow" };
  const roleType = matchRoleType(listing.title, listing.category, searchProfile.roleTypes);
  if (!roleType) return { reason: "roleType" };
  const source: PostingSource = { name: result.name };
  const list = (listing.list ?? result.list)?.trim();
  if (list) source.list = list;
  const postedAt = listing.postedAt === undefined ? Number.NaN : Date.parse(listing.postedAt);
  return {
    candidate: {
      listing,
      source,
      places,
      locationTier,
      level,
      roleType: roleType.name,
      priority: roleType.priority,
      postedOn: Number.isNaN(postedAt) ? postedOnFrom(listing.age, generatedAt) : isoDay(postedAt),
    },
  };
}

/** A Source, or one part of it, that could not be read this time. */
interface FailedScope {
  name: string;
  list?: string;
}

interface Matching {
  candidates: Candidate[];
  filteredOut: FilteredOut;
  addedLeftOut: AddedLeftOut[];
  allPlaces: Place[];
  sourceReports: SourceReport[];
  failed: FailedScope[];
}

/**
 * The Source reads this Refresh uses: the adapter's reads of Sources that are switched on
 * (and of companies still on the watchlist), then the Postings added by URL. The engine
 * checks the switches itself, so a read of a Source the Candidate switched off never counts.
 */
function activeSources(
  sources: readonly SourceResult[],
  sourceSettings: SourceSettings,
  now: string,
): SourceResult[] {
  const watched = new Set(sourceSettings.watchlist.companies.map((company) => company.name));
  const active = sources.filter((source) => {
    if (source.name === JOB_FEED_SOURCE) return sourceSettings.jobFeed.enabled;
    if (source.name === WATCHLIST_SOURCE) {
      return (
        sourceSettings.watchlist.enabled && source.list !== undefined && watched.has(source.list)
      );
    }
    return source.name !== ADDED_BY_URL_SOURCE;
  });
  const { addedByUrl } = sourceSettings;
  if (addedByUrl.enabled && addedByUrl.postings.length > 0) {
    active.push({
      name: ADDED_BY_URL_SOURCE,
      ok: true,
      fetchedAt: now,
      postings: addedByUrl.postings.map((posting) => ({
        applyUrl: posting.url,
        company: posting.company,
        title: posting.title,
        location: posting.location,
        jobType: "",
        age: "",
        postedAt: posting.addedAt,
        category: "",
        companyTier: "",
      })),
    });
  }
  return active;
}

function reportOf(source: SourceResult): SourceReport {
  const report: Pick<SourceReport, "name" | "list"> = { name: source.name };
  if (source.list !== undefined) report.list = source.list;
  return source.ok
    ? { ...report, ok: true, postings: source.postings.length }
    : { ...report, ok: false, postings: 0, error: source.error };
}

function match(
  input: Omit<RefreshInput, "resolvedLinks" | "queue">,
  resolvedLinks: Readonly<Record<string, string>>,
): Matching {
  const filteredOut: FilteredOut = {
    location: 0,
    seniority: 0,
    startWindow: 0,
    roleType: 0,
    company: 0,
    applySite: 0,
  };
  const addedLeftOut: AddedLeftOut[] = [];
  const candidates: Candidate[] = [];
  const placesByText = new Map<string, Place[]>();
  const sourceReports: SourceReport[] = [];
  const failed: FailedScope[] = [];
  const sources = activeSources(
    input.sources,
    input.sourceSettings ?? defaultSourceSettings(),
    input.now,
  );
  let order = 0;
  for (const source of sources) {
    sourceReports.push(reportOf(source));
    if (!source.ok) {
      failed.push(
        source.list === undefined
          ? { name: source.name }
          : { name: source.name, list: source.list },
      );
      continue;
    }
    for (const listing of source.postings) {
      let places = placesByText.get(listing.location);
      if (!places) {
        places = parseLocations(listing.location);
        placesByText.set(listing.location, places);
      }
      const result = evaluate(listing, source, source.fetchedAt, input.settings, places);
      if ("reason" in result) {
        filteredOut[result.reason] += 1;
        if (source.name === ADDED_BY_URL_SOURCE) {
          const { applyUrl: url, company, title } = listing;
          addedLeftOut.push({ url, company, title, reason: result.reason });
        }
        continue;
      }
      const rawUrl = listing.applyUrl.trim();
      const short = isShortLink(rawUrl);
      const target = short ? resolvedLinks[rawUrl] : undefined;
      candidates.push({
        ...result.candidate,
        order: order++,
        rawUrl,
        canonicalUrl: canonicalApplyUrl(target ?? rawUrl),
        unresolved: short && target === undefined,
      });
    }
  }
  return {
    candidates,
    filteredOut,
    addedLeftOut,
    allPlaces: [...placesByText.values()].flat(),
    sourceReports,
    failed,
  };
}

/** The short links among matching Postings, for the adapter to resolve before `runRefresh`. */
export function shortLinksToResolve(
  input: Omit<RefreshInput, "resolvedLinks" | "queue">,
): string[] {
  const { candidates } = match(input, {});
  return [...new Set(candidates.filter((c) => c.unresolved).map((c) => c.rawUrl))];
}

function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Groups candidates that are one job: same canonical URL, or same company, title and places. */
function groupDuplicates(candidates: readonly Candidate[]): Candidate[][] {
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    let node = i;
    while (parent[node] !== root) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  // Same-titled listings at one company and place merge even with different URLs: Sources
  // list one job on several career sites, and applying twice costs more than missing a twin.
  const owner = new Map<string, number>();
  const join = (key: string, i: number) => {
    const other = owner.get(key);
    if (other === undefined) owner.set(key, i);
    else parent[find(i)] = find(other);
  };
  candidates.forEach((candidate, i) => {
    join(`url:${candidate.canonicalUrl}`, i);

    const textKey = [
      companyKey(candidate.listing.company),
      titleKey(candidate.listing.title),
      [...new Set(candidate.places.map(placeKey))].sort().join(";"),
    ].join("|");
    join(`text:${textKey}`, i);
  });
  const groups = new Map<number, Candidate[]>();
  candidates.forEach((candidate, i) => {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(candidate);
    groups.set(root, group);
  });
  return [...groups.values()];
}

/** A place for comparing listings: "Remote" and "Remote in USA" are the same place. */
function placeKey(place: Place): string {
  return place.remote ? `remote:${place.country ?? "US"}` : place.label;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceKey(source: PostingSource): string {
  return `${source.name}\u0000${source.list ?? ""}`;
}

function mergeSources(sources: readonly PostingSource[]): PostingSource[] {
  const unique = new Map(sources.map((source) => [sourceKey(source), source]));
  return [...unique.values()].sort((a, b) => compareText(sourceKey(a), sourceKey(b)));
}

/** A description as a tidy excerpt short enough for the Job List, cut at a word. */
function excerpt(description: string | undefined): string | undefined {
  const text = description?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= POSTING_DESCRIPTION_MAX) return text;
  const cut = text.slice(0, POSTING_DESCRIPTION_MAX);
  const atWord = cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:.-]+$/, "");
  return `${atWord}…`;
}

type Unpicked = Omit<Posting, "resumeVariant">;

/** A sentence as it reads after a colon: "The team" becomes "the team", "AI" stays "AI". */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** A Posting with a Resume Variant picked, and whether the pick was unsure. */
interface Picked {
  posting: Posting;
  unsure: boolean;
}

function withResumeVariant(
  base: Unpicked,
  evidence: VariantEvidence,
  settings: Settings,
  judgments: Readonly<Record<string, VariantJudgment>>,
): Picked {
  const judgment = Object.hasOwn(judgments, base.id) ? judgments[base.id] : undefined;
  if (judgment && settings.resumeVariants.some((v) => v.name === judgment.variant)) {
    return {
      posting: {
        ...base,
        resumeVariant: {
          name: judgment.variant,
          reason: `Reviewed: ${lowerFirst(judgment.reason.replace(/^reviewed\s*:\s*/i, ""))}`,
        },
      },
      unsure: false,
    };
  }
  const { pick, confident } = pickResumeVariant(evidence, settings.resumeVariants);
  return { posting: { ...base, resumeVariant: pick }, unsure: !confident };
}

type Screening = { group: Candidate[] } | { reason: "company" | "applySite" };

/**
 * Applies the Candidate's blocks to one group of duplicates: a blocked company drops the group,
 * and listings on blocked sites drop out, so a Posting stays only while one of its apply URLs is
 * on a site the Candidate still applies on.
 */
function screen(group: readonly Candidate[], settings: Settings): Screening {
  if (group.some((c) => companyRuleOf(c.listing.company, settings.companies) === "block"))
    return { reason: "company" };
  const open = group.filter((c) => !onBlockedSite(c.canonicalUrl, settings.blockedApplySites));
  return open.length === 0 ? { reason: "applySite" } : { group: open };
}

/** One Posting from a group of duplicates, before its Resume Variant is picked. */
function merge(
  group: readonly Candidate[],
  settings: Settings,
  now: string,
): { posting: Unpicked; evidence: VariantEvidence } {
  const tiers = settings.searchProfile.locationTiers;
  // The representative is the earliest listing whose URL is not an unresolved short link.
  const [representative] = [...group].sort(
    (a, b) => Number(a.unresolved) - Number(b.unresolved) || a.order - b.order,
  );
  if (!representative) throw new Error("A duplicate group cannot be empty.");
  const boosts = group.map((c) =>
    companyBoost(c.listing.company, c.listing.companyTier, settings.companies),
  );
  const boost = boosts.reduce((best, next) => (next.value > best.value ? next : best));
  const postedOn = group.map((c) => c.postedOn).sort()[0] ?? representative.postedOn;
  const best = [...group].sort((a, b) => a.locationTier - b.locationTier)[0] ?? representative;
  // A Source sometimes gives an unreadable id as the company; take a real name from a twin.
  const named = group.find((c) => companyKnown(c.listing.company)) ?? representative;
  // Locations in the Candidate's best Location Tiers come first, so the list shows why it matched.
  const tierOfPlace = (place: Place) => locationTierOf([place], tiers) ?? Number.MAX_SAFE_INTEGER;
  const places = representative.places
    .map((place, index) => ({ place, index, tier: tierOfPlace(place) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ place }) => place);
  const description = group.map((c) => c.listing.description).find((text) => text?.trim());
  const posting: Unpicked = {
    id: postingId(representative.canonicalUrl),
    applyUrl: representative.canonicalUrl,
    company: companyKnown(named.listing.company)
      ? displayCompany(named.listing.company)
      : UNKNOWN_COMPANY,
    title: representative.listing.title.replace(/\s+/g, " ").trim(),
    locations: places.length > 0 ? places.slice(0, 60).map((p) => p.label) : ["Unknown"],
    locationTier: best.locationTier,
    roleType: representative.roleType,
    level: representative.level,
    postedOn,
    sources: mergeSources(group.map((c) => c.source)),
    score: score(representative.priority, boost.value, postedOn, now, settings),
    boosts: boost.reasons,
  };
  const short = excerpt(description);
  if (short !== undefined) posting.description = short;
  const evidence: VariantEvidence = {
    title: posting.title,
    roleType: posting.roleType,
    category: representative.listing.category,
  };
  if (description !== undefined) evidence.description = description;
  return { posting, evidence };
}

/**
 * Postings from the current Job List found in a Source (or part of one) that failed this time,
 * re-checked against the settings. They keep only the failed Sources: any other Source was
 * read fresh, and would have listed the Posting again if it still had it.
 */
function carryOver(
  current: CurrentJobList,
  failed: readonly FailedScope[],
  settings: Settings,
  now: string,
): { posting: Unpicked; evidence: VariantEvidence }[] {
  if (failed.length === 0) return [];
  const { roleTypes, seniority, locationTiers } = settings.searchProfile;
  const isFailed = (source: PostingSource) =>
    failed.some(
      (scope) =>
        scope.name === source.name && (scope.list === undefined || scope.list === source.list),
    );
  return current.pages
    .flatMap((page) => page.postings)
    .map((posting) => ({ ...posting, sources: posting.sources.filter(isFailed) }))
    .filter((posting) => posting.sources.length > 0)
    .flatMap((posting) => {
      const locationTier = locationTierOf(posting.locations.flatMap(parseLocations), locationTiers);
      const roleType = matchRoleType(posting.title, "", roleTypes);
      if (locationTier === undefined || !roleType || !seniority.includes(posting.level)) return [];
      if (companyRuleOf(posting.company, settings.companies) === "block") return [];
      if (onBlockedSite(posting.applyUrl, settings.blockedApplySites)) return [];
      // The company tier is not kept on a Posting; it is read back from the recorded reasons.
      const tier = posting.boosts
        .map((reason) => /^Company tier (.+)$/.exec(reason)?.[1])
        .find(Boolean);
      const boost = companyBoost(
        posting.company,
        tier === undefined ? "" : `Tier ${tier}`,
        settings.companies,
      );
      // The old pick is replaced once the Resume Variant is picked again.
      const kept: Unpicked = {
        ...posting,
        locationTier,
        roleType: roleType.name,
        score: score(roleType.priority, boost.value, posting.postedOn, now, settings),
        boosts: boost.reasons,
      };
      const evidence: VariantEvidence = { title: kept.title, roleType: kept.roleType };
      if (kept.description !== undefined) evidence.description = kept.description;
      return [{ posting: kept, evidence }];
    });
}

function compareRank(a: Posting, b: Posting): number {
  return (
    a.locationTier - b.locationTier ||
    b.score - a.score ||
    compareText(b.postedOn, a.postedOn) ||
    compareText(companyKey(a.company), companyKey(b.company)) ||
    compareText(a.title, b.title) ||
    compareText(a.id, b.id)
  );
}

export function runRefresh(input: RefreshInput): RefreshResult {
  const { now, settings, current } = input;
  const matching = match(input, input.resolvedLinks ?? {});
  const judgments = input.variantJudgments ?? {};
  const pick = ({ posting, evidence }: { posting: Unpicked; evidence: VariantEvidence }) =>
    withResumeVariant(posting, evidence, settings, judgments);
  const fresh: Picked[] = [];
  for (const group of groupDuplicates(matching.candidates)) {
    const screened = screen(group, settings);
    if (!("reason" in screened)) {
      fresh.push(pick(merge(screened.group, settings, now)));
      continue;
    }
    matching.filteredOut[screened.reason] += 1;
    for (const { listing, source } of group) {
      if (source.name !== ADDED_BY_URL_SOURCE) continue;
      const { applyUrl: url, company, title } = listing;
      matching.addedLeftOut.push({ url, company, title, reason: screened.reason });
    }
  }
  const freshIds = new Set(fresh.map((p) => p.posting.id));
  const freshUrls = new Set(fresh.map((p) => p.posting.applyUrl));
  const carriedPicks = carryOver(current, matching.failed, settings, now)
    .filter(({ posting: p }) => !freshIds.has(p.id) && !freshUrls.has(p.applyUrl))
    .map(pick);
  const carried = carriedPicks.map((p) => p.posting);
  const rankedPicks = [...fresh, ...carriedPicks].sort((a, b) => compareRank(a.posting, b.posting));
  const ranked = rankedPicks.map((p) => p.posting);
  const jobList = ranked.slice(0, MAX_JOB_LIST);
  const unsure = rankedPicks.slice(0, MAX_JOB_LIST).filter((p) => p.unsure);

  const pages: JobListPage[] = [];
  for (let start = 0; start < jobList.length; start += POSTINGS_PER_PAGE) {
    pages.push({
      schemaVersion: 1,
      refreshedAt: now,
      page: pages.length + 1,
      postings: jobList.slice(start, start + POSTINGS_PER_PAGE),
    });
  }
  const meta: JobListMeta = {
    schemaVersion: 1,
    refreshedAt: now,
    pageCount: pages.length,
    total: jobList.length,
    matched: ranked.length,
    sources: matching.sourceReports,
  };
  const queue = planQueue({
    now,
    dailyQueueTarget: settings.dailyQueueTarget,
    jobList,
    queue: input.queue,
  });
  const referrals = planReferrals({
    now,
    connections: input.connections,
    cards: [...input.queue.cards, ...queue.cards],
    cardIds: [...input.queue.cardIds, ...queue.cards.map((c) => c.postingId)],
    current: input.referrals?.docs ?? new Map(),
    currentIds: input.referrals?.ids ?? [],
    calls: input.referralCalls ?? {},
  });
  const keptPages = new Set(pages.map((p) => jobListPageId(p.page)));
  const changeSet: ChangeSet = {
    set: [
      ...pages.map((data) => ({
        collection: POSTINGS_COLLECTION,
        docId: jobListPageId(data.page),
        data,
      })),
      { collection: POSTINGS_COLLECTION, docId: JOB_LIST_META_ID, data: meta },
      ...queue.cards.map((data) => ({
        collection: CARDS_COLLECTION,
        docId: data.postingId,
        data,
      })),
      ...referrals.set.map((data) => ({
        collection: REFERRALS_COLLECTION,
        docId: data.postingId,
        data,
      })),
    ],
    delete: [
      ...current.pages
        .map((page) => jobListPageId(page.page))
        .filter((docId) => !keptPages.has(docId))
        .sort()
        .map((docId) => ({ collection: POSTINGS_COLLECTION, docId })),
      ...referrals.delete.map((docId) => ({ collection: REFERRALS_COLLECTION, docId })),
    ],
  };

  const previousIds = new Set(current.pages.flatMap((page) => page.postings.map((p) => p.id)));
  const nextIds = new Set(jobList.map((p) => p.id));
  const byTier = settings.searchProfile.locationTiers.map(
    (_, index) => jobList.filter((p) => p.locationTier === index + 1).length,
  );
  const summary: RefreshSummary = {
    refreshedAt: now,
    total: jobList.length,
    matched: ranked.length,
    newPostings: [...nextIds].filter((id) => !previousIds.has(id)).length,
    removedPostings: [...previousIds].filter((id) => !nextIds.has(id)).length,
    byTier,
    sources: matching.sourceReports,
    filteredOut: matching.filteredOut,
    unresolvedLinks: new Set(matching.candidates.filter((c) => c.unresolved).map((c) => c.rawUrl))
      .size,
    carriedOver: carried.filter((p) => nextIds.has(p.id)).length,
    // With no Source read, nothing can be said about which entries match.
    unmatchedLocations:
      matching.allPlaces.length === 0
        ? []
        : unmatchedTierLocations(matching.allPlaces, settings.searchProfile.locationTiers),
    byVariant: Object.fromEntries(
      settings.resumeVariants.map((variant) => [
        variant.name,
        jobList.filter((p) => p.resumeVariant.name === variant.name).length,
      ]),
    ),
    variantReview: {
      unsure: unsure.length,
      postings: unsure.slice(0, MAX_VARIANT_REVIEW).map(({ posting: p }) => ({
        id: p.id,
        company: p.company,
        title: p.title,
        roleType: p.roleType,
        applyUrl: p.applyUrl,
        picked: p.resumeVariant.name,
        reason: p.resumeVariant.reason,
      })),
    },
    addedLeftOut: matching.addedLeftOut,
    top: jobList
      .slice(0, 5)
      .map(({ company, title, locations, locationTier, score: s, applyUrl }) => ({
        company,
        title,
        locations,
        locationTier,
        score: s,
        applyUrl,
      })),
    queue: queue.summary,
    referrals: referrals.summary,
  };
  return {
    jobList,
    meta,
    preQueued: queue.cards,
    changeSet,
    summary,
    referralReview: referrals.review,
    referralCalls: referrals.calls,
  };
}
