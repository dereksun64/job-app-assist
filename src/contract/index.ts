/**
 * The dashboard contract: the single definition of every document in the dashboard database.
 * Skills write only documents this module accepts, and the dashboard page reads through it.
 */
import { CARDS_COLLECTION, validateCardDocument } from "./cards.ts";
import { NEWS_COLLECTION, validateNewsDocument } from "./news.ts";
import { POSTINGS_COLLECTION, validatePostingsDocument } from "./postings.ts";
import { REFERRALS_COLLECTION, validateReferralsDocument } from "./referrals.ts";
import { SETTINGS_COLLECTION, SETTINGS_DOC_ID, validateSettings } from "./settings.ts";
import { SKIPS_COLLECTION, validateSkipDocument } from "./skips.ts";
import { SOURCES_COLLECTION, validateSourceDocument } from "./sources.ts";
import type { Validation } from "./validation.ts";
import {
  VARIANT_OVERRIDES_COLLECTION,
  validateVariantOverrideDocument,
} from "./variant-overrides.ts";

export * from "./cards.ts";
export * from "./news.ts";
export * from "./postings.ts";
export * from "./referrals.ts";
export * from "./settings-diff.ts";
export * from "./settings.ts";
export * from "./skips.ts";
export * from "./variant-overrides.ts";
export * from "./sources.ts";
export { canonicalApplyUrl, isShortLink } from "./apply-urls.ts";
export type { Validation } from "./validation.ts";

type CollectionRule = (docId: string, input: unknown) => Validation<unknown>;

const collections: Record<string, CollectionRule> = {
  [SETTINGS_COLLECTION]: (docId, input) =>
    docId === SETTINGS_DOC_ID
      ? validateSettings(input)
      : {
          ok: false,
          issues: [`The settings collection holds one document, with the id "${SETTINGS_DOC_ID}".`],
        },
  [POSTINGS_COLLECTION]: validatePostingsDocument,
  [CARDS_COLLECTION]: validateCardDocument,
  [SKIPS_COLLECTION]: validateSkipDocument,
  [VARIANT_OVERRIDES_COLLECTION]: validateVariantOverrideDocument,
  [SOURCES_COLLECTION]: validateSourceDocument,
  [NEWS_COLLECTION]: validateNewsDocument,
  [REFERRALS_COLLECTION]: validateReferralsDocument,
};

/** The collections the contract defines so far. */
export const CONTRACT_COLLECTIONS: readonly string[] = Object.keys(collections);

/** Checks one document, addressed by collection and id, against the contract. */
export function validateDocument(
  collection: string,
  docId: string,
  input: unknown,
): Validation<unknown> {
  const rule = Object.hasOwn(collections, collection) ? collections[collection] : undefined;
  if (!rule) {
    return {
      ok: false,
      issues: [`"${collection}" is not a collection in the dashboard contract.`],
    };
  }
  return rule(docId, input);
}
