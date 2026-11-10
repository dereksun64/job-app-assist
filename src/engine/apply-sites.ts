/** Apply sites: the host an apply URL points to, matched against the Candidate's blocked sites. */

/** True when the URL's host is one of the sites or a subdomain of one. */
export function onBlockedSite(url: string, sites: readonly string[]): boolean {
  if (sites.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** The registrable part of an apply URL's host (the last two labels), for grouping by site. */
export function applySiteOf(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return host.split(".").slice(-2).join(".");
}
