/**
 * `jaa check-resumes <manifest> [--settings <file|->]`: checks the Candidate's Resume Variant
 * files before Setup saves them. The manifest (`.job-app-assist/resume-variants.json`) pairs each
 * Resume Variant's name with its file in the Candidate folder. It stays on the Candidate's own
 * computer: the dashboard database holds only the names and picking rules, never the files.
 */
import { isAbsolute, normalize } from "node:path";
import * as z from "zod/mini";
import { MAX_RESUME_VARIANTS, validateSettings } from "../contract/index.ts";
import { validateWith } from "../contract/validation.ts";

export interface ResumeIo {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  /** The size in bytes of a regular file, or undefined when there is none at `path`. */
  fileSize(path: string): Promise<number | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
}

const RESUME_FILE = /\.(pdf|docx?)$/i;

const manifest = z.strictObject({
  variants: z
    .array(
      z.strictObject({
        name: z
          .string()
          .check(
            z.trim(),
            z.minLength(1, "must not be blank"),
            z.maxLength(60, "must be 60 characters or fewer"),
          ),
        file: z.string().check(
          z.trim(),
          z.refine(
            (path) => path !== "" && !isAbsolute(path) && !normalize(path).startsWith(".."),
            "must be a path inside the Candidate folder, relative to it",
          ),
          z.regex(RESUME_FILE, "must be a PDF or Word file (.pdf, .docx or .doc)"),
        ),
      }),
    )
    .check(
      z.minLength(1, "list at least one Resume Variant"),
      z.maxLength(MAX_RESUME_VARIANTS, `keep at most ${String(MAX_RESUME_VARIANTS)}`),
      z.superRefine((variants, ctx) => {
        const seen = new Set<string>();
        for (const { name } of variants) {
          const key = name.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({
              code: "custom",
              message: `${name} is listed more than once`,
              input: name,
            });
          }
          seen.add(key);
        }
      }),
    ),
});

async function readJson(io: ResumeIo, source: string): Promise<unknown> {
  const text = source === "-" ? await io.readStdin() : await io.readFile(source);
  return JSON.parse(text) as unknown;
}

function fail(io: ResumeIo, lines: readonly string[]): number {
  io.stderr(lines.map((line) => `${line}\n`).join(""));
  return 1;
}

export async function runCheckResumes(
  manifestPath: string,
  settingsSource: string | undefined,
  io: ResumeIo,
): Promise<number> {
  let json: unknown;
  try {
    json = await readJson(io, manifestPath);
  } catch (error) {
    return fail(io, [`Could not read ${manifestPath} as JSON: ${messageOf(error)}`]);
  }
  const result = validateWith(manifest, json);
  if (!result.ok) {
    return fail(io, [
      `${manifestPath} does not list the Resume Variants as expected:`,
      ...result.issues.map((issue) => `- ${issue}`),
    ]);
  }
  const { variants } = result.value;

  const problems: string[] = [];
  for (const { file } of variants) {
    const size = await io.fileSize(file);
    if (size === undefined) problems.push(`- ${file} is not in the Candidate folder.`);
    else if (size === 0) problems.push(`- ${file} is empty.`);
  }

  if (settingsSource !== undefined) {
    let settingsJson: unknown;
    try {
      settingsJson = await readJson(io, settingsSource);
    } catch (error) {
      return fail(io, [`Could not read the settings document as JSON: ${messageOf(error)}`]);
    }
    const settings = validateSettings(settingsJson);
    if (!settings.ok) {
      problems.push(
        "- The settings document does not match the dashboard contract; run jaa validate settings main on it.",
      );
    } else {
      const inSettings = settings.value.resumeVariants.map((v) => v.name);
      const inManifest = variants.map((v) => v.name);
      if (inSettings.join("\u0000") !== inManifest.join("\u0000")) {
        problems.push(
          `- The settings document lists ${inSettings.join(", ")}; the Resume Variant files are for ${inManifest.join(", ")}. List the same names in the same order in both.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    return fail(io, [`The Resume Variants in ${manifestPath} need fixing:`, ...problems]);
  }
  io.stdout(
    `${String(variants.length)} Resume ${variants.length === 1 ? "Variant" : "Variants"}, every file found:\n${variants
      .map(({ name, file }) => `- ${name}: ${file}\n`)
      .join("")}`,
  );
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
