/**
 * What the Refresh engine reads from each Source, already fetched by the adapter.
 * The engine never fetches anything itself (see src/engine/refresh.ts).
 */

/** One Posting as a Source lists it, before any filtering or cleanup. */
export interface SourcePosting {
  applyUrl: string;
  company: string;
  title: string;
  /** Location text as the Source wrote it, possibly several run together. */
  location: string;
  /** The Source's own job type, for example "internship" or "full-time". */
  jobType: string;
  /** How long ago the Source says it was posted, for example "3d", "1mo" or "Aug 12". */
  age: string;
  /** The Source's own section or category, for example "AI/ML". */
  category: string;
  /** The Source's company tier, for example "Tier 1" or "Unlisted". */
  companyTier: string;
  /** Where inside the Source the Posting was listed, for example "Simplify New Grad". */
  list?: string;
  /** The Posting's description, when the Source gives one (the Job Feed does not). */
  description?: string;
}

export type SourceResult =
  | {
      name: string;
      ok: true;
      /** When the Source's data was generated; Posting ages count back from here. */
      fetchedAt: string;
      postings: readonly SourcePosting[];
    }
  | { name: string; ok: false; error: string };

/** The name of the shared Source every Candidate starts with. */
export { JOB_FEED_SOURCE as JOB_FEED } from "../contract/index.ts";
