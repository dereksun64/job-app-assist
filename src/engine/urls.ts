/**
 * Posting ids. Canonical apply URLs live in the contract (src/contract/apply-urls.ts), so the
 * dashboard page and the engine reduce URLs the same way; ids need Node's crypto.
 */
import { createHash } from "node:crypto";

export { canonicalApplyUrl, isShortLink } from "../contract/apply-urls.ts";

/** A Posting's id: the first 12 hex characters of the SHA-256 of its canonical apply URL. */
export function postingId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 12);
}
