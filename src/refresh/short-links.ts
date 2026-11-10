/**
 * Resolving the Job Feed's short links to the real application site, so each Posting shows
 * where the Candidate will actually apply and duplicates across lists can be merged.
 * Each link costs one HEAD request that is not followed; answers are cached by the caller.
 */
import { isShortLink } from "../engine/urls.ts";
import type { Fetch } from "./job-feed.ts";

export interface ResolveOptions {
  fetch: Fetch;
  /** Links already resolved on an earlier Refresh. */
  cache?: Readonly<Record<string, string>>;
  concurrency?: number;
  timeoutMs?: number;
}

export interface ResolveResult {
  /** Every requested link that now has a destination, cached ones included. */
  resolved: Record<string, string>;
  failed: string[];
}

const MAX_HOPS = 3;

async function resolveOne(
  link: string,
  fetch: Fetch,
  timeoutMs: number,
): Promise<string | undefined> {
  let current = link;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return undefined;
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return undefined;
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return undefined;
    }
    if (!isShortLink(next)) return next;
    current = next;
  }
  return undefined;
}

export async function resolveShortLinks(
  links: readonly string[],
  { fetch, cache = {}, concurrency = 12, timeoutMs = 10_000 }: ResolveOptions,
): Promise<ResolveResult> {
  const resolved: Record<string, string> = {};
  const pending: string[] = [];
  for (const link of new Set(links)) {
    const known = cache[link];
    if (known !== undefined) resolved[link] = known;
    else pending.push(link);
  }
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const link = pending[next++];
      if (link === undefined) break;
      const target = await resolveOne(link, fetch, timeoutMs);
      if (target === undefined) failed.push(link);
      else resolved[link] = target;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  failed.sort();
  return { resolved, failed };
}
