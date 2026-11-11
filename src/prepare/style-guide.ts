/**
 * `jaa style-guide init|check <file>`: the Candidate's Style Guide, `style-guide.md` in the
 * Candidate folder. It says how the Candidate sounds (tone, phrases to avoid, sample answers),
 * and every AI-drafted answer follows it: the drafting Claude reads it, and `jaa prepare build`
 * refuses a draft that uses a phrase it lists. It stays in the Candidate folder.
 */
import { isAbsolute, normalize } from "node:path";
import { messageOf, type FillIo } from "../fill/io.ts";

export const STYLE_GUIDE_FILE = "style-guide.md";

export const STYLE_GUIDE_TEMPLATE = `# Style Guide

<!-- How you sound in application answers. Your Claude follows this for every answer it drafts for you. It stays on your computer. Short notes are fine. -->

## Tone

<!-- A few lines on how you write: plain or polished, short or detailed, how formal. For example: "Direct and warm. Short sentences. Concrete numbers over adjectives." -->

## Phrases to avoid

<!-- One per line, as "- phrase". Your Claude never uses these in an answer. For example:
- passionate about
- I am excited to
- leverage
-->

## Sample answers

<!-- Paste two or three answers you wrote yourself, each under its question as a "### " heading. Your Claude matches their voice. -->
`;

export interface StyleGuide {
  /** The tone section's text, or "" when it is empty. */
  tone: string;
  /** The phrases no draft may use. */
  avoid: string[];
  /** How many sample answers the guide holds. */
  samples: number;
}

/** The guide's text by `## ` section, lower-cased names, with HTML comments removed. */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] && !line.startsWith("###")) {
      current = [];
      out.set(heading[1].toLowerCase(), current);
    } else {
      current?.push(line);
    }
  }
  return out;
}

export function readStyleGuide(text: string): StyleGuide {
  const parts = sections(text);
  const tone = (parts.get("tone") ?? []).join("\n").trim();
  const avoid = (parts.get("phrases to avoid") ?? [])
    .map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim() ?? "")
    .map((phrase) => phrase.replace(/^["'“‘](.*)["'”’]$/, "$1").trim())
    .filter((phrase) => phrase !== "");
  const sampleLines = parts.get("sample answers") ?? [];
  const headed = sampleLines.filter((line) => /^###\s+\S/.test(line)).length;
  const hasText = sampleLines.some((line) => line.trim() !== "");
  return { tone, avoid, samples: headed > 0 ? headed : hasText ? 1 : 0 };
}

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/** The phrases from `avoid` that `draft` uses, ignoring case and spacing. */
export function avoidedPhrasesIn(draft: string, avoid: readonly string[]): string[] {
  const body = squash(draft);
  return avoid.filter((phrase) => body.includes(squash(phrase)));
}

/** A file's text, or undefined when it cannot be read. */
export async function readText(io: FillIo, path: string): Promise<string | undefined> {
  try {
    return await io.readFile(path);
  } catch {
    return undefined;
  }
}

function insideCandidateFolder(path: string): boolean {
  return path.trim() !== "" && !isAbsolute(path) && !normalize(path).startsWith("..");
}

const plural = (n: number, word: string, many = `${word}s`) =>
  `${String(n)} ${n === 1 ? word : many}`;

export async function runStyleGuide(
  step: "init" | "check",
  path: string,
  io: FillIo,
): Promise<number> {
  if (!insideCandidateFolder(path)) {
    io.stderr(`${path} must be a path inside the Candidate folder, relative to it.\n`);
    return 1;
  }
  const existing = await readText(io, path);

  if (step === "init") {
    if (existing !== undefined) {
      io.stdout(`${path} already exists; it was left as it is.\n`);
      return 0;
    }
    try {
      await io.writeFile(path, STYLE_GUIDE_TEMPLATE);
    } catch (error) {
      io.stderr(`Could not create ${path}: ${messageOf(error)}\n`);
      return 1;
    }
    io.stdout(`Created ${path} in the Candidate folder.\n`);
    return 0;
  }

  if (existing === undefined) {
    io.stderr(
      `There is no ${path} in the Candidate folder yet. Run /job-app-assist:setup to write your Style Guide.\n`,
    );
    return 1;
  }
  const guide = readStyleGuide(existing);
  if (guide.tone === "") {
    io.stderr(
      `${path} has no tone yet. Write a few lines under "## Tone" on how you sound; phrases to avoid and sample answers are optional but help.\n`,
    );
    return 1;
  }
  io.stdout(
    `${path} has a tone, ${plural(guide.avoid.length, "phrase")} to avoid and ${plural(guide.samples, "sample answer")}.\n` +
      "Every AI-drafted answer follows it.\n",
  );
  return 0;
}
