/**
 * `jaa fill plan|start|finish`: the deterministic parts of Fill. The Fill skill saves the
 * dashboard state into `<dir>/state` with ArtifactData, and these commands decide what to fill
 * and in which order, build each card document Fill writes, and log each application's token
 * use. Filling the form itself is Claude's work in Helium; nothing here touches a browser.
 *
 * Layout of `<dir>` (the skill uses `.job-app-assist/fill`):
 * - `state/settings/main.json`, `state/cards/<id>.json`, `state/variantOverrides/<id>.json`:
 *   documents saved from the dashboard.
 * - `out/plan.json`: the Queued cards to fill, in Queue order.
 * - `out/cards/<id>.json` and `out/writes.json`: the card to save and the batch that saves it.
 * - `started/<id>.json`: when Fill started each card, for its token count.
 * - `results/<id>.json`: what Claude did on the form (outcome, Simplify, flags).
 * - `usage.jsonl`: one line per finished application with its token use; it stays on this
 *   computer, so the README can give a realistic daily target per Claude plan.
 */
import { join, resolve } from "node:path";
import {
  CARDS_COLLECTION,
  STAGE_LABELS,
  canonicalApplyUrl,
  chosenVariant,
  compareQueueOrder,
  finalAnswers,
  finishFill,
  startFill,
  validateCardDocument,
  validateSettings,
  APPLICATIONS_COLLECTION,
  validateApplicationDocument,
  type Card,
  type FillRecord,
  type FinalAnswer,
  type PreparedApplication,
} from "../contract/index.ts";
import { FillError, messageOf, type FillIo } from "./io.ts";
import { readCards, readJsonFile, readManifest, readOverrides, savedIds } from "./state.ts";
import { PRIVATE_ANSWERS_FILE } from "./private-answers.ts";
import { sessionUsage, type TokenUsage } from "./usage.ts";

const POSTING_ID = /^[0-9a-f]{12}$/;

export const FILL_USAGE = `       jaa fill plan <dir> [--posting <words|id|apply URL>]
       jaa fill start <dir> <posting-id> --version <n>
       jaa fill finish <dir> <posting-id> --version <n>`;

/** One Posting in the plan Fill works through. */
export interface PlannedPosting {
  postingId: string;
  company: string;
  title: string;
  applyUrl: string;
  resumeVariant: { name: string; file: string; byCandidate: boolean };
  /** The platform, when the apply URL is on one that usually needs a sign-in. */
  signInLikely?: string;
  /** Set when an earlier Fill stopped without finishing this card. */
  fillingSince?: string;
  /**
   * The final answer to each free-text question, from the card's Prepared Application; absent
   * when the card has none yet, so Fill prepares it from the form.
   */
  answers?: FinalAnswer[];
}

/** Hosts of applicant tracking systems that usually ask for a sign-in or a new account. */
const SIGN_IN_SITES: [RegExp, string][] = [
  [/(^|\.)myworkday(jobs|site)\.com$/, "Workday"],
  [/(^|\.)icims\.com$/, "iCIMS"],
  [/(^|\.)taleo\.net$/, "Taleo"],
  [/(^|\.)successfactors\.(com|eu)$/, "SuccessFactors"],
  [/(^|\.)oraclecloud\.com$/, "Oracle Cloud"],
  [/(^|\.)brassring\.com$/, "BrassRing"],
  [/(^|\.)ultipro\.com$/, "UKG"],
  [/(^|\.)adp\.com$/, "ADP"],
];

export function signInSite(applyUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(applyUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return SIGN_IN_SITES.find(([pattern]) => pattern.test(host))?.[1];
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const plural = (n: number, word: string, many = `${word}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;
const fmt = (n: number) => n.toLocaleString("en-US");
const name = (card: Card) => `${card.posting.company} - ${card.posting.title}`;

async function readApplications(
  io: FillIo,
  dir: string,
): Promise<Map<string, PreparedApplication>> {
  const folder = join(dir, "state", APPLICATIONS_COLLECTION);
  const found = new Map<string, PreparedApplication>();
  for (const id of await savedIds(io, folder)) {
    const result = validateApplicationDocument(
      id,
      await readJsonFile(io, join(folder, `${id}.json`)),
    );
    if (result.ok) found.set(id, result.value);
  }
  return found;
}

function preparedLine(answers: readonly FinalAnswer[] | undefined): string {
  if (answers === undefined) return "No Prepared Application yet: prepare it from the form";
  if (answers.length === 0) return "Prepared Application: no free-text questions";
  const typed = answers.filter((a) => a.answer !== null).length;
  const blank = answers.length - typed;
  const parts = [plural(typed, "answer") + " to type"];
  if (blank > 0) parts.push(`${plural(blank, "brief-mode answer")} the Candidate has not written`);
  return `Prepared Application: ${parts.join(", ")}`;
}

/** The cards a query names: by Posting id, by apply URL, or by words in company and title. */
function matching(cards: readonly Card[], query: string): Card[] {
  const q = query.trim();
  const byId = cards.filter((c) => c.postingId === q.toLowerCase());
  if (byId.length > 0) return byId;
  if (/^https?:\/\//i.test(q)) {
    const url = canonicalApplyUrl(q);
    return cards.filter((c) => canonicalApplyUrl(c.posting.applyUrl) === url);
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter((c) => {
    const text = `${c.posting.company} ${c.posting.title}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

async function plan(dir: string, query: string | undefined, io: FillIo): Promise<number> {
  if ((await io.fileSize(PRIVATE_ANSWERS_FILE)) === undefined) {
    throw new FillError(
      `There is no ${PRIVATE_ANSWERS_FILE} in the Candidate folder, so Fill has no private file for sensitive answers. Run /job-app-assist:setup to create it.`,
    );
  }
  const settings = validateSettings(
    await readJsonFile(io, join(dir, "state", "settings", "main.json")),
  );
  if (!settings.ok) {
    throw new FillError(
      `${join(dir, "state", "settings", "main.json")} is missing or does not match the dashboard contract. Run /job-app-assist:setup to save your settings.`,
    );
  }
  const variantNames = settings.value.resumeVariants.map((v) => v.name);
  const files = await readManifest(io);
  const overrides = await readOverrides(io, dir);
  const applications = await readApplications(io, dir);
  const cards = await readCards(io, dir);
  const queued = cards.filter((c) => c.stage === "queued").sort(compareQueueOrder);

  let chosen = queued;
  if (query !== undefined) {
    const named = matching(queued, query);
    if (named.length > 1) {
      throw new FillError(
        `"${query}" matches ${String(named.length)} Queued Postings; say which one:\n` +
          named.map((c) => `- ${name(c)} (${c.postingId})`).join("\n"),
      );
    }
    if (named.length === 0) {
      const elsewhere = matching(cards, query);
      if (elsewhere.length === 1 && elsewhere[0]) {
        const [card] = elsewhere;
        throw new FillError(
          `${name(card)} is ${STAGE_LABELS[card.stage]}, not Queued. Drag it back to Queued on the board to fill it again.`,
        );
      }
      throw new FillError(
        `No card on your board matches "${query}". Queue the Posting on the Postings tab first, then ask again.`,
      );
    }
    chosen = named;
  }

  const postings: PlannedPosting[] = [];
  const problems: string[] = [];
  for (const card of chosen) {
    const variant = chosenVariant(card.posting, overrides.get(card.postingId), variantNames);
    const file = files.get(variant.name);
    if (file === undefined) {
      problems.push(
        `- No Resume Variant file is recorded for ${variant.name} (${name(card)}). Run /job-app-assist:setup to add it, or choose another Resume Variant in the Posting's drawer.`,
      );
      continue;
    }
    if (!(((await io.fileSize(file)) ?? 0) > 0)) {
      problems.push(`- ${file} (${variant.name}) is not in the Candidate folder, or it is empty.`);
      continue;
    }
    const planned: PlannedPosting = {
      postingId: card.postingId,
      company: card.posting.company,
      title: card.posting.title,
      applyUrl: card.posting.applyUrl,
      resumeVariant: { name: variant.name, file: resolve(file), byCandidate: variant.byCandidate },
    };
    const site = signInSite(card.posting.applyUrl);
    if (site !== undefined) planned.signInLikely = site;
    if (card.fillingSince !== undefined) planned.fillingSince = card.fillingSince;
    const application = applications.get(card.postingId);
    if (application !== undefined) planned.answers = finalAnswers(application);
    postings.push(planned);
  }
  if (problems.length > 0) {
    throw new FillError(
      `Fill needs every chosen resume first:\n${[...new Set(problems)].join("\n")}`,
    );
  }

  const planPath = join(dir, "out", "plan.json");
  await io.makeDir(join(dir, "out"));
  await io.writeFile(planPath, json({ postings }));

  if (postings.length === 0) {
    io.stdout(
      `Your Queue is empty, so there is nothing to fill. Tick Postings on the Postings tab, then ask again.\nPlan saved to ${planPath}.\n`,
    );
    return 0;
  }
  const lines = postings.map((p, i) => {
    const out = [
      `${String(i + 1)}. ${p.company} - ${p.title} (${p.postingId})`,
      `   ${p.applyUrl}`,
      `   Resume Variant: ${p.resumeVariant.name}${p.resumeVariant.byCandidate ? " (your choice)" : ""} - ${p.resumeVariant.file}`,
    ];
    if (p.signInLikely) out.push(`   Usually needs a sign-in: ${p.signInLikely}`);
    if (p.fillingSince)
      out.push(`   Still marked as filling from an earlier Fill (${p.fillingSince})`);
    out.push(`   ${preparedLine(p.answers)}`);
    return out.join("\n");
  });
  const heading =
    query === undefined
      ? `${plural(postings.length, "Queued Posting")} to fill, in Queue order:`
      : `${plural(postings.length, "Queued Posting")} to fill:`;
  io.stdout(`${heading}\n${lines.join("\n")}\nPlan saved to ${planPath}.\n`);
  return 0;
}

async function readCard(io: FillIo, dir: string, id: string): Promise<Card> {
  const path = join(dir, "state", CARDS_COLLECTION, `${id}.json`);
  const input = await readJsonFile(io, path);
  if (input === undefined) {
    throw new FillError(
      `Save the card with ArtifactData (get, out_dir ${join(dir, "state")}) first: ${path} is missing.`,
    );
  }
  const result = validateCardDocument(id, input);
  if (!result.ok) {
    throw new FillError(
      `${path} does not match the dashboard contract:\n${result.issues.map((i) => `- ${i}`).join("\n")}`,
    );
  }
  return result.value as Card;
}

/** Saves the card to write and the one-write batch that saves it, guarded by its version. */
async function writeCard(io: FillIo, dir: string, card: Card, version: number): Promise<string> {
  const cardPath = join(dir, "out", CARDS_COLLECTION, `${card.postingId}.json`);
  const writesPath = join(dir, "out", "writes.json");
  await io.makeDir(join(dir, "out", CARDS_COLLECTION));
  await io.writeFile(cardPath, `${JSON.stringify(card)}\n`);
  const write = {
    op: "set",
    collection: CARDS_COLLECTION,
    doc_id: card.postingId,
    file_path: cardPath,
    if_version: version,
  };
  await io.writeFile(writesPath, json({ batches: [[write]] }));
  return writesPath;
}

async function start(dir: string, id: string, version: number, io: FillIo): Promise<number> {
  const card = await readCard(io, dir, id);
  const at = io.now();
  let started: Card;
  try {
    started = startFill(card, at);
  } catch (error) {
    throw new FillError(messageOf(error));
  }
  const writesPath = await writeCard(io, dir, started, version);
  await io.makeDir(join(dir, "started"));
  await io.writeFile(join(dir, "started", `${id}.json`), `${JSON.stringify({ startedAt: at })}\n`);
  io.stdout(
    `${name(card)}: marked as filling. Send the batch in ${writesPath} with ArtifactData.\n`,
  );
  return 0;
}

interface UsageLine {
  outcome?: unknown;
  tokens?: { total?: unknown } | null;
}

async function finish(dir: string, id: string, version: number, io: FillIo): Promise<number> {
  const card = await readCard(io, dir, id);
  const resultPath = join(dir, "results", `${id}.json`);
  const result = await readJsonFile(io, resultPath);
  if (
    result === undefined ||
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result)
  ) {
    throw new FillError(
      `Write what Fill did on the form to ${resultPath} first: { "outcome", "simplify", "resumeVariant", "flags" }.`,
    );
  }
  const at = io.now();
  const record = { ...result, at } as FillRecord;
  const done = finishFill(card, record);
  const check = validateCardDocument(id, done);
  if (!check.ok) {
    throw new FillError(
      `${resultPath} needs fixing:\n${check.issues.map((i) => `- ${i}`).join("\n")}`,
    );
  }

  const startedAt = (
    (await readJsonFile(io, join(dir, "started", `${id}.json`))) as
      { startedAt?: unknown } | undefined
  )?.startedAt;
  const tokens: TokenUsage | undefined =
    typeof startedAt === "string" ? await sessionUsage(io, startedAt, at) : undefined;

  const writesPath = await writeCard(io, dir, done, version);

  const logPath = join(dir, "usage.jsonl");
  const earlier = await io.readFile(logPath).catch(() => "");
  const entry = {
    postingId: id,
    company: card.posting.company,
    title: card.posting.title,
    startedAt: typeof startedAt === "string" ? startedAt : null,
    finishedAt: at,
    outcome: record.outcome,
    simplify: record.simplify,
    flags: record.flags.length,
    tokens: tokens ?? null,
  };
  const log = `${earlier}${earlier === "" || earlier.endsWith("\n") ? "" : "\n"}${JSON.stringify(entry)}\n`;
  await io.writeFile(logPath, log);

  const totals: number[] = [];
  for (const line of log.split("\n")) {
    try {
      const parsed = JSON.parse(line) as UsageLine;
      if (parsed.outcome === "filled" && typeof parsed.tokens?.total === "number")
        totals.push(parsed.tokens.total);
    } catch {
      // Blank or unreadable lines are not applications.
    }
  }

  const flags = plural(record.flags.length, "flag");
  const lines = [
    record.outcome === "filled"
      ? done.stage === "ready_for_review"
        ? `${name(card)}: filled, moving to Ready for Review with ${flags}.`
        : `${name(card)}: filled with ${flags}; it stays ${STAGE_LABELS[done.stage]}, where you moved it.`
      : record.outcome === "needs_sign_in"
        ? `${name(card)}: needs a sign-in, staying Queued with ${flags}.`
        : `${name(card)}: Fill stopped, staying Queued with ${flags}.`,
    `Send the batch in ${writesPath} with ArtifactData.`,
    tokens
      ? `Tokens for this application: ${fmt(tokens.total)} over ${plural(tokens.messages, "response")} (${fmt(tokens.cacheRead)} cache reads, ${fmt(tokens.cacheCreation)} cache writes, ${fmt(tokens.input)} input, ${fmt(tokens.output)} output).`
      : "Token use for this application could not be measured: this session's transcript was not found.",
  ];
  if (totals.length > 0) {
    const average = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
    lines.push(
      `${plural(totals.length, "filled application")} logged so far, averaging ${fmt(average)} tokens each.`,
    );
  }
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

/** Runs `jaa fill <step> ...` and resolves its exit code; 2 means the arguments were wrong. */
export async function runFill(argv: readonly string[], io: FillIo): Promise<number> {
  const [step, dir, ...rest] = argv;
  const usage = () => {
    io.stderr(`Usage: ${FILL_USAGE.trimStart()}\n`);
    return 2;
  };
  if (!dir || dir.startsWith("--")) return usage();
  try {
    if (step === "plan") {
      if (rest.length === 0) return await plan(dir, undefined, io);
      if (rest.length === 2 && rest[0] === "--posting" && rest[1]?.trim())
        return await plan(dir, rest[1], io);
      return usage();
    }
    if (step === "start" || step === "finish") {
      const [id, flag, value, ...extra] = rest;
      const version = Number(value);
      if (
        !id ||
        !POSTING_ID.test(id) ||
        flag !== "--version" ||
        !Number.isInteger(version) ||
        version < 1 ||
        extra.length > 0
      ) {
        return usage();
      }
      return step === "start"
        ? await start(dir, id, version, io)
        : await finish(dir, id, version, io);
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
