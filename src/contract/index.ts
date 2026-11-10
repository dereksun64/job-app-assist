/**
 * The dashboard contract: the single definition of every document in the dashboard database.
 * Skills write only documents this module accepts, and the dashboard page reads through it.
 */
import { POSTINGS_COLLECTION, validatePostingsDocument } from "./postings.ts";
import { SETTINGS_COLLECTION, SETTINGS_DOC_ID, validateSettings } from "./settings.ts";
import type { Validation } from "./validation.ts";

export * from "./postings.ts";
export * from "./settings.ts";
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
};

/** The collections the contract defines so far; later tickets add sources, cards and more. */
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
