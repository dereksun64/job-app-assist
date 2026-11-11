/**
 * `jaa prepare plan|build`: the deterministic parts of preparing Prepared Applications. Refresh
 * runs `plan` for the Queued cards it can prepare ahead of Fill, Claude drafts the answers and a
 * Research Brief for each into `<dir>/prepared/<posting id>.json`, and `build` checks them
 * against the plan, the Style Guide and the dashboard contract and builds the documents to
 * write. Fill runs `build --posting` for a card with none, from the questions it read on the
 * live form. Neither ever replaces a Prepared Application that exists: from then on it is the
 * Candidate's to edit in the drawer.
 *
 * Layout of `<dir>` (Refresh uses `.job-app-assist/refresh`, Fill `.job-app-assist/fill`):
 * - `state/settings/main.json`, `state/cards/<id>.json`, `state/applications/<id>.json`,
 *   `state/variantOverrides/<id>.json`: documents saved from the dashboard.
 * - `out/cards/<id>.json`: cards this Refresh pre-queued, not yet in the saved state.
 * - `out/prepare-plan.json`: the Postings to prepare, with their questions.
 * - `prepared/<id>.json`: Claude's answers and Research Brief for one Posting.
 * - `out/applications/<id>.json` and `out/application-writes.json`: what to write.
 */
import { join, resolve } from "node:path";
import {
  APPLICATIONS_COLLECTION,
  QUESTION_TYPES,
  chosenVariant,
  compareQueueOrder,
  defaultMode,
  finalAnswers,
  validateApplicationDocument,
  validateCardDocument,
  validateSettings,
  type Card,
  type PreparedApplication,
  type QuestionType,
} from "../contract/index.ts";
import { FillError, type FillIo } from "../fill/io.ts";
import { readCards, readJsonFile, readManifest, readOverrides, savedIds } from "../fill/state.ts";
import type { Fetch } from "../refresh/job-feed.ts";
import { batchesOf, type BatchWrite } from "../refresh/run.ts";
import { readFormQuestions, type FormQuestion } from "./greenhouse.ts";
import {
  STYLE_GUIDE_FILE,
  avoidedPhrasesIn,
  readStyleGuide,
  readText,
  type StyleGuide,
} from "./style-guide.ts";

export interface PrepareIo extends FillIo {
  fetch: Fetch;
}

export const PREPARE_USAGE = `       jaa prepare plan <dir>
       jaa prepare build <dir> [--posting <posting-id>]`;

const POSTING_ID = /^[0-9a-f]{12}$/;

/** One Posting to prepare ahead of Fill. */
export interface PlannedPreparation {
  postingId: string;
  company: string;
  title: string;
  roleType: string;
  applyUrl: string;
  /** The Resume Variant Fill will upload, for how the role fits the Candidate. */
  resumeVariant: { name: string; file?: string };
  /** The job description, from the form's site or the Posting's Source. */
  description?: string;
  questions: FormQuestion[];
  /** Where Claude writes the answers; absent when the form has no free-text question. */
  answersFile?: string;
}

/** A Queued Posting whose questions cannot be read ahead, so Fill prepares it from the form. */
export interface LaterPreparation {
  postingId: string;
  company: string;
  title: string;
  reason: string;
}

export interface PreparePlan {
  styleGuide: string;
  postings: PlannedPreparation[];
  later: LaterPreparation[];
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const plural = (n: number, word: string, many = `${word}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;
const name = (of: { company: string; title: string }) => `${of.company} - ${of.title}`;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The Style Guide, which every AI-drafted answer follows; preparing stops without one. */
async function requireStyleGuide(io: FillIo): Promise<StyleGuide> {
  const text = await readText(io, STYLE_GUIDE_FILE);
  if (text === undefined) {
    throw new FillError(
      `There is no ${STYLE_GUIDE_FILE} in the Candidate folder, so there is no Style Guide for AI-drafted answers. Run /job-app-assist:setup to write it.`,
    );
  }
  const guide = readStyleGuide(text);
  if (guide.tone === "") {
    throw new FillError(
      `${STYLE_GUIDE_FILE} has no tone yet, so AI-drafted answers would not sound like you. Write a few lines under "## Tone", or run /job-app-assist:setup.`,
    );
  }
  return guide;
}

async function preparedIds(io: FillIo, dir: string): Promise<Set<string>> {
  // Any saved document counts, readable or not, so nothing ever writes over one.
  return new Set(await savedIds(io, join(dir, "state", APPLICATIONS_COLLECTION)));
}

async function plan(dir: string, io: PrepareIo): Promise<number> {
  await requireStyleGuide(io);
  const settingsPath = join(dir, "state", "settings", "main.json");
  const settings = validateSettings(await readJsonFile(io, settingsPath));
  if (!settings.ok) {
    throw new FillError(
      `${settingsPath} is missing or does not match the dashboard contract. Run /job-app-assist:setup to save your settings.`,
    );
  }
  const variantNames = settings.value.resumeVariants.map((v) => v.name);
  const files = await readManifest(io);
  const overrides = await readOverrides(io, dir);
  const byId = new Map<string, Card>();
  for (const card of [...(await readCards(io, dir)), ...(await readCards(io, dir, "out"))]) {
    byId.set(card.postingId, card);
  }
  const prepared = await preparedIds(io, dir);
  const queued = [...byId.values()]
    .filter((card) => card.stage === "queued" && !prepared.has(card.postingId))
    .sort(compareQueueOrder);

  const postings: PlannedPreparation[] = [];
  const later: LaterPreparation[] = [];
  for (const card of queued) {
    const { posting } = card;
    const form = await readFormQuestions(posting.applyUrl, io.fetch);
    if (form.kind !== "read") {
      later.push({
        postingId: card.postingId,
        company: posting.company,
        title: posting.title,
        reason:
          form.kind === "unsupported"
            ? `${hostOf(posting.applyUrl)} does not list its questions ahead of the form`
            : `its questions could not be read: ${form.reason}`,
      });
      continue;
    }
    const variant = chosenVariant(posting, overrides.get(card.postingId), variantNames);
    const file = files.get(variant.name);
    const entry: PlannedPreparation = {
      postingId: card.postingId,
      company: posting.company,
      title: posting.title,
      roleType: posting.roleType,
      applyUrl: posting.applyUrl,
      resumeVariant:
        file === undefined ? { name: variant.name } : { name: variant.name, file: resolve(file) },
      questions: form.questions,
    };
    const description = form.description ?? posting.description;
    if (description) entry.description = description;
    if (form.questions.length > 0)
      entry.answersFile = join(dir, "prepared", `${card.postingId}.json`);
    postings.push(entry);
  }

  const planPath = join(dir, "out", "prepare-plan.json");
  await io.makeDir(join(dir, "out"));
  await io.writeFile(
    planPath,
    json({ styleGuide: STYLE_GUIDE_FILE, postings, later } satisfies PreparePlan),
  );

  const total = postings.length + later.length;
  if (total === 0) {
    io.stdout(`Every Queued Posting has a Prepared Application.\nPlan saved to ${planPath}.\n`);
    return 0;
  }
  const lines = [
    ...postings.map((p) =>
      p.answersFile === undefined
        ? `- ${name(p)} (${p.postingId}): no free-text questions, nothing to write.`
        : `- ${name(p)} (${p.postingId}): ${plural(p.questions.length, "free-text question")}. Write ${p.answersFile}.`,
    ),
    ...later.map(
      (p) => `- ${name(p)} (${p.postingId}): Fill prepares it from the form (${p.reason}).`,
    ),
  ];
  io.stdout(
    `${plural(total, "Queued Posting")} ${total === 1 ? "has" : "have"} no Prepared Application:\n${lines.join("\n")}\nPlan saved to ${planPath}.\n`,
  );
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isQuestionType = (value: unknown): value is QuestionType =>
  typeof value === "string" && (QUESTION_TYPES as readonly string[]).includes(value);

/**
 * The Prepared Application built from Claude's answers file, or the problems to fix. Each
 * answer's mode comes from its question type, never from the file. With `planned`, the file
 * must answer exactly the questions the form asks.
 */
function buildApplication(
  card: { postingId: string },
  input: unknown,
  guide: StyleGuide,
  preparedBy: PreparedApplication["preparedBy"],
  at: string,
  planned: readonly FormQuestion[] | undefined,
): { ok: true; doc: PreparedApplication } | { ok: false; problems: string[] } {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, problems: ['It must be { "questions": [...], "brief": {...} }.'] };
  }
  const problems: string[] = [];
  const questions = input.questions.map((raw: unknown, index) => {
    const item = isRecord(raw) ? raw : {};
    if (!isQuestionType(item.type)) {
      problems.push(`questions.${String(index)}.type: must be one of ${QUESTION_TYPES.join(", ")}`);
    }
    const question: Record<string, unknown> = {
      question: item.question,
      type: item.type,
      mode: isQuestionType(item.type) ? defaultMode(item.type) : "ai",
      draft: item.draft,
    };
    if (item.maxLength !== undefined) question.maxLength = item.maxLength;
    return question;
  });
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    postingId: card.postingId,
    preparedAt: at,
    preparedBy,
    questions,
    updatedAt: at,
  };
  if (input.brief !== undefined) doc.brief = input.brief;
  if (problems.length > 0) return { ok: false, problems };

  const check = validateApplicationDocument(card.postingId, doc);
  if (!check.ok) return { ok: false, problems: check.issues };
  for (const q of check.value.questions) {
    for (const phrase of avoidedPhrasesIn(q.draft, guide.avoid)) {
      problems.push(`"${q.question}": uses "${phrase}", which your Style Guide avoids`);
    }
  }
  if (planned !== undefined) {
    const key = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
    const asked = new Set(planned.map((q) => key(q.question)));
    const answered = new Set(check.value.questions.map((q) => key(q.question)));
    for (const q of check.value.questions) {
      if (!asked.has(key(q.question))) {
        problems.push(
          `"${q.question}" is not on the form; answer only the questions the plan lists`,
        );
      }
    }
    for (const q of planned) {
      if (!answered.has(key(q.question))) {
        problems.push(`"${q.question}" has no answer; answer every question the plan lists`);
      }
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, doc: check.value };
}

function describe(doc: PreparedApplication): string {
  if (doc.questions.length === 0) return "no free-text questions.";
  const ai = doc.questions.filter((q) => q.mode === "ai").length;
  const brief = doc.questions.length - ai;
  const parts = [];
  if (ai > 0) parts.push(plural(ai, "AI-drafted answer"));
  if (brief > 0) parts.push(`${plural(brief, "Research Brief answer")} for you to write`);
  return `${parts.join(", ")}.`;
}

async function writeApplications(
  io: FillIo,
  dir: string,
  docs: readonly PreparedApplication[],
): Promise<string> {
  const folder = join(dir, "out", APPLICATIONS_COLLECTION);
  await io.makeDir(folder);
  const writes: { write: BatchWrite; bytes: number }[] = [];
  for (const doc of docs) {
    const filePath = join(folder, `${doc.postingId}.json`);
    const text = `${JSON.stringify(doc)}\n`;
    await io.writeFile(filePath, text);
    // No if_version: the document is new, and only the Candidate changes it from now on.
    writes.push({
      write: {
        op: "set",
        collection: APPLICATIONS_COLLECTION,
        doc_id: doc.postingId,
        file_path: filePath,
      },
      bytes: Buffer.byteLength(text),
    });
  }
  const writesPath = join(dir, "out", "application-writes.json");
  await io.writeFile(writesPath, json({ batches: batchesOf(writes) }));
  return writesPath;
}

function fixList(file: string, problems: readonly string[]): string {
  return `${file} needs fixing:\n${problems.map((p) => `- ${p}`).join("\n")}`;
}

async function buildFromPlan(dir: string, io: PrepareIo): Promise<number> {
  const guide = await requireStyleGuide(io);
  const planPath = join(dir, "out", "prepare-plan.json");
  const saved = (await readJsonFile(io, planPath)) as PreparePlan | undefined;
  if (!saved || !Array.isArray(saved.postings)) {
    throw new FillError(`There is no ${planPath}. Run jaa prepare plan ${dir} first.`);
  }
  const prepared = await preparedIds(io, dir);
  const at = io.now();
  const docs: PreparedApplication[] = [];
  const missing: PlannedPreparation[] = [];
  const failures: string[] = [];
  for (const planned of saved.postings) {
    if (prepared.has(planned.postingId)) continue;
    let input: unknown = { questions: [] };
    if (planned.answersFile !== undefined) {
      input = await readJsonFile(io, planned.answersFile);
      if (input === undefined) {
        missing.push(planned);
        continue;
      }
    }
    const built = buildApplication(planned, input, guide, "refresh", at, planned.questions);
    if (built.ok) docs.push(built.doc);
    else failures.push(fixList(planned.answersFile ?? planned.postingId, built.problems));
  }
  if (failures.length > 0) throw new FillError(failures.join("\n"));

  const lines: string[] = [];
  if (docs.length > 0) {
    const writesPath = await writeApplications(io, dir, docs);
    const names = new Map(saved.postings.map((p) => [p.postingId, name(p)]));
    lines.push(`${plural(docs.length, "Prepared Application")} to write:`);
    for (const doc of docs)
      lines.push(`- ${names.get(doc.postingId) ?? doc.postingId}: ${describe(doc)}`);
    lines.push(`Send the batch in ${writesPath} with ArtifactData.`);
  } else {
    lines.push("There are no Prepared Applications to write.");
  }
  if (missing.length > 0) {
    lines.push("Not prepared, so Fill prepares it from the form:");
    for (const p of missing) lines.push(`- ${name(p)} (no ${p.answersFile ?? ""})`);
  }
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

async function buildForPosting(dir: string, id: string, io: PrepareIo): Promise<number> {
  const guide = await requireStyleGuide(io);
  const cardPath = join(dir, "state", "cards", `${id}.json`);
  const cardInput = await readJsonFile(io, cardPath);
  if (cardInput === undefined) {
    throw new FillError(
      `Save the card with ArtifactData (get, out_dir ${join(dir, "state")}) first: ${cardPath} is missing.`,
    );
  }
  const cardCheck = validateCardDocument(id, cardInput);
  if (!cardCheck.ok) throw new FillError(`${cardPath} does not match the dashboard contract.`);
  const card = cardCheck.value as Card;
  if ((await preparedIds(io, dir)).has(id)) {
    throw new FillError(
      `${name(card.posting)} already has a Prepared Application; use its answers from the plan.`,
    );
  }
  const answersFile = join(dir, "prepared", `${id}.json`);
  const input = await readJsonFile(io, answersFile);
  if (input === undefined) {
    throw new FillError(`Write the answers and Research Brief to ${answersFile} first.`);
  }
  const built = buildApplication(card, input, guide, "fill", io.now(), undefined);
  if (!built.ok) throw new FillError(fixList(answersFile, built.problems));

  const writesPath = await writeApplications(io, dir, [built.doc]);
  io.stdout(
    `${name(card.posting)}: ${describe(built.doc)}\nSend the batch in ${writesPath} with ArtifactData.\n${formatAnswers(built.doc)}`,
  );
  return 0;
}

/** What Fill types for each question, as lines for the skill to follow. */
export function formatAnswers(doc: PreparedApplication): string {
  if (doc.questions.length === 0) return "";
  const lines = finalAnswers(doc).map((a) =>
    a.answer === null
      ? `- "${a.question}": leave blank and flag it as free_text; the Candidate writes it under the Research Brief.`
      : `- "${a.question}" (${a.source === "ai" ? "AI-drafted" : a.source === "edited" ? "edited by the Candidate" : "the Candidate's own words"}): ${a.answer}`,
  );
  return `Answers for the form:\n${lines.join("\n")}\n`;
}

/** Runs `jaa prepare <step> ...` and resolves its exit code; 2 means the arguments were wrong. */
export async function runPrepare(argv: readonly string[], io: PrepareIo): Promise<number> {
  const [step, dir, ...rest] = argv;
  const usage = () => {
    io.stderr(`Usage: ${PREPARE_USAGE.trimStart()}\n`);
    return 2;
  };
  if (!dir || dir.startsWith("--")) return usage();
  try {
    if (step === "plan" && rest.length === 0) return await plan(dir, io);
    if (step === "build" && rest.length === 0) return await buildFromPlan(dir, io);
    if (
      step === "build" &&
      rest.length === 2 &&
      rest[0] === "--posting" &&
      POSTING_ID.test(rest[1] ?? "")
    ) {
      return await buildForPosting(dir, rest[1] ?? "", io);
    }
    return usage();
  } catch (error) {
    if (error instanceof FillError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
