/**
 * Apply URLs: the identity of a Posting. Two listings of one job often differ only in tracking
 * parameters or in how an applicant tracking system spells its host, so URLs are reduced to a
 * canonical form before Postings are compared.
 */
import { createHash } from "node:crypto";

/** Hosts whose links only redirect to the real application site. */
const SHORT_LINK_HOSTS = new Set(["go.vansh.nyc"]);

const TRACKING_PARAMS = new Set([
  "ref",
  "refs",
  "referrer",
  "source",
  "src",
  "gh_src",
  "lever-source",
  "lever-origin",
  "iis",
  "iisn",
  "trk",
  "campaign",
  "medium",
  "embed",
]);

const HOST_ALIASES: Record<string, string> = {
  "boards.greenhouse.io": "job-boards.greenhouse.io",
};

function parse(url: string): URL | undefined {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isShortLink(url: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase());
}

/** The canonical form of an apply URL; text that is not a web address is returned as is. */
export function canonicalApplyUrl(url: string): string {
  const parsed = parse(url);
  if (!parsed) return url.trim();
  let host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  host = HOST_ALIASES[host] ?? host;
  let path = parsed.pathname.replace(/\/+$/, "");
  if (host === "jobs.lever.co") path = path.replace(/\/apply$/, "");
  if (host === "jobs.ashbyhq.com") path = path.replace(/\/application$/, "");
  const params = [...parsed.searchParams]
    .filter(([key]) => {
      const name = key.toLowerCase();
      if (name.startsWith("utm_") || TRACKING_PARAMS.has(name)) return false;
      // The Job Feed's short links tag their list in `s`; it does not change the target.
      return !(name === "s" && SHORT_LINK_HOSTS.has(host));
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return `https://${host}${port}${path}${query}`;
}

/** A Posting's id: the first 12 hex characters of the SHA-256 of its canonical apply URL. */
export function postingId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 12);
}
