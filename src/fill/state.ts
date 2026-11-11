/**
 * Reading the dashboard state Fill and Prepare save with ArtifactData (`<dir>/state/...`) and
 * the Resume Variant manifest in the Candidate folder. A saved document outside the contract is
 * left out.
 */
import { join } from "node:path";
import {
  CARDS_COLLECTION,
  validateCardDocument,
  validateVariantOverrideDocument,
  type Card,
  type VariantOverride,
} from "../contract/index.ts";
import { FillError, type FillIo } from "./io.ts";

export const RESUME_MANIFEST = ".job-app-assist/resume-variants.json";

export async function readJsonFile(io: FillIo, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FillError(`${path} is not valid JSON.`);
  }
}

export async function savedIds(io: FillIo, folder: string): Promise<string[]> {
  return (await io.readDir(folder))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** The cards saved in `<dir>/<from>/cards`: the dashboard state, or cards a command built. */
export async function readCards(io: FillIo, dir: string, from = "state"): Promise<Card[]> {
  const folder = join(dir, from, CARDS_COLLECTION);
  const cards: Card[] = [];
  for (const id of await savedIds(io, folder)) {
    const result = validateCardDocument(id, await readJsonFile(io, join(folder, `${id}.json`)));
    if (result.ok) cards.push(result.value as Card);
  }
  return cards;
}

export async function readOverrides(
  io: FillIo,
  dir: string,
): Promise<Map<string, VariantOverride>> {
  const folder = join(dir, "state", "variantOverrides");
  const overrides = new Map<string, VariantOverride>();
  for (const id of await savedIds(io, folder)) {
    const result = validateVariantOverrideDocument(
      id,
      await readJsonFile(io, join(folder, `${id}.json`)),
    );
    if (result.ok) overrides.set(id, result.value);
  }
  return overrides;
}

export async function readManifest(io: FillIo): Promise<Map<string, string>> {
  const problem = new FillError(
    `${RESUME_MANIFEST} does not list your Resume Variant files. Run /job-app-assist:setup to record them.`,
  );
  const manifest = (await readJsonFile(io, RESUME_MANIFEST)) as
    { variants?: { name?: unknown; file?: unknown }[] } | undefined;
  if (!Array.isArray(manifest?.variants)) throw problem;
  const files = new Map<string, string>();
  for (const { name: variant, file } of manifest.variants) {
    if (typeof variant !== "string" || typeof file !== "string") throw problem;
    files.set(variant, file);
  }
  return files;
}
