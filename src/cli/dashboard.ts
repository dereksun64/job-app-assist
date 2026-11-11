/**
 * `jaa dashboard check|page|record <dir>`: keeps the Candidate's dashboard page in step with the
 * Toolkit. The page ships in the plugin (`dist/dashboard.html`) stamped with the plugin version,
 * and `<dir>/dashboard.json` (the skills use `.job-app-assist`) records the dashboard's link and
 * the page version last published there. Every skill runs `check` first: when the plugin's page
 * is newer, it copies the page into the Candidate folder for the Artifact tool to publish in
 * place, which keeps the database and its data. Publishing itself is Claude's work; this only
 * decides and records.
 */
import { join } from "node:path";
import * as z from "zod/mini";
import { validateWith } from "../contract/validation.ts";

export interface DashboardIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  /** The installed plugin's folder, which holds `.claude-plugin/plugin.json` and `dist/`. */
  pluginRoot(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const DASHBOARD_USAGE = `       jaa dashboard check <dir>
       jaa dashboard page <dir>
       jaa dashboard record <dir> <artifact-url> [--replace]`;

const DASHBOARD_FILE = "dashboard.json";
const PAGE_FILE = "dashboard.html";
const UPDATE_COMMAND = "claude plugin update job-app-assist@job-app-assist";

const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/;

const artifactUrl = z
  .string()
  .check(
    z.regex(ARTIFACT_URL, "must be a claude.ai artifact link (https://claude.ai/artifact/...)"),
  );

const recordSchema = z.looseObject({
  url: artifactUrl,
  pageVersion: z.optional(z.string()),
});

type Recorded = z.output<typeof recordSchema>;

class DashboardError extends Error {}

/**
 * Orders two versions like `0.12.0` part by part as numbers; a missing part counts as 0.
 * Negative when `a` is older, positive when it is newer.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function pluginVersion(io: DashboardIo): Promise<string> {
  const path = join(io.pluginRoot(), ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await io.readFile(path)) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new DashboardError(`${path} has no version.`);
  return manifest.version;
}

async function readRecorded(io: DashboardIo, dir: string): Promise<Recorded | undefined> {
  const path = join(dir, DASHBOARD_FILE);
  let text: string;
  try {
    text = await io.readFile(path);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DashboardError(`${path} is not valid JSON. Run /job-app-assist:setup to repair it.`);
  }
  const check = validateWith(recordSchema, parsed);
  if (!check.ok) {
    throw new DashboardError(
      `${path} needs fixing:\n${check.issues.map((issue) => `- ${issue}`).join("\n")}\nRun /job-app-assist:setup to repair it.`,
    );
  }
  return check.value;
}

async function copyPage(io: DashboardIo, dir: string): Promise<string> {
  const page = await io.readFile(join(io.pluginRoot(), "dist", PAGE_FILE));
  await io.makeDir(dir);
  const target = join(dir, PAGE_FILE);
  await io.writeFile(target, page);
  return target;
}

async function check(io: DashboardIo, dir: string): Promise<void> {
  const recorded = await readRecorded(io, dir);
  if (recorded === undefined) {
    throw new DashboardError(
      `There is no dashboard yet (no ${join(dir, DASHBOARD_FILE)}). Run /job-app-assist:setup to create it.`,
    );
  }
  const latest = await pluginVersion(io);
  const published = recorded.pageVersion;
  const order = published === undefined ? 1 : compareVersions(latest, published);
  if (order === 0) {
    io.stdout(`The dashboard page is up to date (${latest}). Nothing to publish.\n`);
    return;
  }
  if (order < 0) {
    io.stdout(
      `The published dashboard page (${published ?? ""}) is newer than this Toolkit (${latest}), so it stays as it is. ` +
        `This computer has an older Toolkit: the Candidate can update it with \`${UPDATE_COMMAND}\`.\n`,
    );
    return;
  }
  const page = await copyPage(io, dir);
  io.stdout(
    [
      `The Toolkit has a newer dashboard page: ${latest}, replacing ${published ?? "an unrecorded version"}.`,
      `Publish ${page} to ${recorded.url} with the Artifact tool, without capabilities, so the page keeps its database and data.`,
      `Then run: jaa dashboard record ${dir} ${recorded.url}`,
      "",
    ].join("\n"),
  );
}

async function page(io: DashboardIo, dir: string): Promise<void> {
  const target = await copyPage(io, dir);
  io.stdout(`Copied the dashboard page, version ${await pluginVersion(io)}, to ${target}.\n`);
}

async function record(io: DashboardIo, dir: string, url: string, replace: boolean) {
  const check = validateWith(artifactUrl, url);
  if (!check.ok) throw new DashboardError(`${url} ${check.issues.join("; ")}.`);
  const recorded = await readRecorded(io, dir).catch((error: unknown) => {
    if (replace) return undefined;
    throw error;
  });
  if (recorded !== undefined && recorded.url !== url && !replace) {
    throw new DashboardError(
      `This Candidate folder already records the dashboard ${recorded.url}. ` +
        "Publish to that link to keep its data; pass --replace only when the Candidate chose to switch to another dashboard.",
    );
  }
  const version = await pluginVersion(io);
  const next = { ...(recorded ?? {}), url, pageVersion: version };
  await io.makeDir(dir);
  await io.writeFile(join(dir, DASHBOARD_FILE), `${JSON.stringify(next, null, 2)}\n`);
  io.stdout(`Recorded the dashboard ${url} with page version ${version}.\n`);
}

/** Runs `jaa dashboard <step> ...` and resolves its exit code. */
export async function runDashboard(argv: readonly string[], io: DashboardIo): Promise<number> {
  const [step, dir, ...rest] = argv;
  try {
    if (step === "check" && dir && rest.length === 0) await check(io, dir);
    else if (step === "page" && dir && rest.length === 0) await page(io, dir);
    else if (
      step === "record" &&
      dir &&
      rest[0] !== undefined &&
      (rest.length === 1 || (rest.length === 2 && rest[1] === "--replace"))
    ) {
      await record(io, dir, rest[0], rest[1] === "--replace");
    } else {
      io.stderr(`Usage:\n${DASHBOARD_USAGE}\n`);
      return 2;
    }
    return 0;
  } catch (error) {
    if (error instanceof DashboardError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
