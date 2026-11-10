/**
 * The Refresh engine core: Source Postings, the settings document and the current Job List in;
 * the new Job List, a change set of dashboard writes and a summary out. It is deterministic and
 * makes no network or Claude calls: fetching Sources and resolving short links happen in the
 * adapter (src/refresh/), which hands this module plain data.
 */
import {
  JOB_LIST_META_ID,
  MAX_JOB_LIST,
  POSTINGS_COLLECTION,
  POSTINGS_PER_PAGE,
  jobListPageId,
  type JobListMeta,
  type JobListPage,
  type LocationTier,
  type Posting,
  type PostingSource,
  type RoleTypePriority,
  type Seniority,
  type Settings,
  type SourceReport,
} from "../contract/index.ts";
import {
  companyBoost,
  companyKey,
  companyKnown,
  displayCompany,
  UNKNOWN_COMPANY,
} from "./companies.ts";
import { freshness, postedOnFrom } from "./freshness.ts";
import { locationTierOf, parseLocations, unmatchedTierLocations, type Place } from "./locations.ts";
import { levelOf, matchRoleType, withinStartWindow } from "./roles.ts";
import type { SourcePosting, SourceResult } from "./source.ts";
import { canonicalApplyUrl, isShortLink, postingId } from "./urls.ts";

/** The Job List as the dashboard database holds it now. */
export interface CurrentJobList {
  meta?: JobListMeta;
  pages: readonly JobListPage[];
}

export interface RefreshInput {
  /** When this Refresh runs, as an ISO timestamp; it stamps every document written. */
  now: string;
  settings: Settings;
  sources: readonly SourceResult[];
  current: CurrentJobList;
  /** Where each short link leads, from the adapter. Unresolved links stay as they are. */
  resolvedLinks?: Readonly<Record<string, string>>;
}

export interface ChangeSet {
  /** Documents to write whole, pages first and the meta document last. */
  set: { collection: string; docId: string; data: JobListPage | JobListMeta }[];
  /** Documents to remove. */
  delete: { collection: string; docId: string }[];
}

export interface FilteredOut {
  location: number;
  seniority: number;
  startWindow: number;
  roleType: number;
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
  top: Pick<Posting, "company" | "title" | "locations" | "locationTier" | "score" | "applyUrl">[];
}

export interface RefreshResult {
  jobList: Posting[];
  meta: JobListMeta;
  changeSet: ChangeSet;
  summary: RefreshSummary;
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
const WEIGHTS = { fit: 0.5, boost: 0.3, freshness: 0.2 };

function score(priority: RoleTypePriority, boost: number, postedOn: string, now: string): number {
  const value =
    WEIGHTS.fit * FIT[priority] +
    WEIGHTS.boost * boost +
    WEIGHTS.freshness * freshness(postedOn, now);
  return Math.round(100 * value);
}

type Evaluation =
  | { candidate: Omit<Candidate, "order" | "rawUrl" | "canonicalUrl" | "unresolved"> }
  | { reason: keyof FilteredOut };

function evaluate(
  listing: SourcePosting,
  sourceName: string,
  generatedAt: string,
  settings: Settings,
  places: Place[],
): Evaluation {
  const { searchProfile } = settings;
  const locationTier = locationTierOf(places, searchProfile.locationTiers);
  if (locationTier === undefined) return { reason: "location" };
  const level = levelOf(listing.title, listing.jobType);
  if (level === undefined || !searchProfile.seniority.includes(level))
    return { reason: "seniority" };
  if (!withinStartWindow(listing.title, searchProfile.startWindow))
    return { reason: "startWindow" };
  const roleType = matchRoleType(listing.title, listing.category, searchProfile.roleTypes);
  if (!roleType) return { reason: "roleType" };
  const source: PostingSource = { name: sourceName };
  const list = listing.list?.trim();
  if (list) source.list = list;
  return {
    candidate: {
      listing,
      source,
      places,
      locationTier,
      level,
      roleType: roleType.name,
      priority: roleType.priority,
      postedOn: postedOnFrom(listing.age, generatedAt),
    },
  };
}

interface Matching {
  candidates: Candidate[];
  filteredOut: FilteredOut;
  allPlaces: Place[];
  sourceReports: SourceReport[];
  failedSources: Set<string>;
}

function match(
  input: Omit<RefreshInput, "resolvedLinks">,
  resolvedLinks: Readonly<Record<string, string>>,
): Matching {
  const filteredOut: FilteredOut = { location: 0, seniority: 0, startWindow: 0, roleType: 0 };
  const candidates: Candidate[] = [];
  const placesByText = new Map<string, Place[]>();
  const sourceReports: SourceReport[] = [];
  const failedSources = new Set<string>();
  let order = 0;
  for (const source of input.sources) {
    if (!source.ok) {
      failedSources.add(source.name);
      sourceReports.push({ name: source.name, ok: false, postings: 0, error: source.error });
      continue;
    }
    sourceReports.push({ name: source.name, ok: true, postings: source.postings.length });
    for (const listing of source.postings) {
      let places = placesByText.get(listing.location);
      if (!places) {
        places = parseLocations(listing.location);
        placesByText.set(listing.location, places);
      }
      const result = evaluate(listing, source.name, source.fetchedAt, input.settings, places);
      if ("reason" in result) {
        filteredOut[result.reason] += 1;
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
    allPlaces: [...placesByText.values()].flat(),
    sourceReports,
    failedSources,
  };
}

/** The short links among matching Postings, for the adapter to resolve before `runRefresh`. */
export function shortLinksToResolve(input: Omit<RefreshInput, "resolvedLinks">): string[] {
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
      candidate.places
        .map((p) => p.label)
        .sort()
        .join(";"),
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

/** One Posting from a group of duplicates. */
function merge(group: readonly Candidate[], tiers: readonly LocationTier[], now: string): Posting {
  // The representative is the earliest listing whose URL is not an unresolved short link.
  const [representative] = [...group].sort(
    (a, b) => Number(a.unresolved) - Number(b.unresolved) || a.order - b.order,
  );
  if (!representative) throw new Error("A duplicate group cannot be empty.");
  const boosts = group.map((c) => companyBoost(c.listing.company, c.listing.companyTier));
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
  return {
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
    score: score(representative.priority, boost.value, postedOn, now),
    boosts: boost.reasons,
  };
}

/** Postings from the current Job List whose Source failed, re-checked against the settings. */
function carryOver(
  current: CurrentJobList,
  failed: ReadonlySet<string>,
  settings: Settings,
  now: string,
): Posting[] {
  if (failed.size === 0) return [];
  const { roleTypes, seniority, locationTiers } = settings.searchProfile;
  return current.pages
    .flatMap((page) => page.postings)
    .filter((posting) => posting.sources.some((source) => failed.has(source.name)))
    .flatMap((posting) => {
      const locationTier = locationTierOf(posting.locations.flatMap(parseLocations), locationTiers);
      const roleType = matchRoleType(posting.title, "", roleTypes);
      if (locationTier === undefined || !roleType || !seniority.includes(posting.level)) return [];
      return [
        {
          ...posting,
          locationTier,
          roleType: roleType.name,
          score: score(roleType.priority, companyBoostFromReasons(posting), posting.postedOn, now),
        },
      ];
    });
}

/** A kept Posting's boost, from the reasons it recorded when it was ranked. */
function companyBoostFromReasons(posting: Posting): number {
  const tier = posting.boosts
    .map((reason) => /^Company tier (.+)$/.exec(reason)?.[1])
    .find(Boolean);
  const fromTier = tier === undefined ? 0 : companyBoost("", `Tier ${tier}`).value;
  return Math.max(
    posting.boosts.includes("Fortune 500") ? companyBoost("Walmart", "").value : 0,
    fromTier,
  );
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
  const fresh = groupDuplicates(matching.candidates).map((group) =>
    merge(group, settings.searchProfile.locationTiers, now),
  );
  const freshIds = new Set(fresh.map((p) => p.id));
  const freshUrls = new Set(fresh.map((p) => p.applyUrl));
  const carried = carryOver(current, matching.failedSources, settings, now).filter(
    (p) => !freshIds.has(p.id) && !freshUrls.has(p.applyUrl),
  );
  const ranked = [...fresh, ...carried].sort(compareRank);
  const jobList = ranked.slice(0, MAX_JOB_LIST);

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
  const keptPages = new Set(pages.map((p) => jobListPageId(p.page)));
  const changeSet: ChangeSet = {
    set: [
      ...pages.map((data) => ({
        collection: POSTINGS_COLLECTION,
        docId: jobListPageId(data.page),
        data,
      })),
      { collection: POSTINGS_COLLECTION, docId: JOB_LIST_META_ID, data: meta },
    ],
    delete: current.pages
      .map((page) => jobListPageId(page.page))
      .filter((docId) => !keptPages.has(docId))
      .sort()
      .map((docId) => ({ collection: POSTINGS_COLLECTION, docId })),
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
    unmatchedLocations: unmatchedTierLocations(
      matching.allPlaces,
      settings.searchProfile.locationTiers,
    ),
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
  };
  return { jobList, meta, changeSet, summary };
}
