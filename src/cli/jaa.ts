/**
 * `jaa`: the Toolkit's command-line entry point, bundled into plugin/dist/jaa.mjs.
 * Skills run it to check a document against the dashboard contract before writing it, and the
 * Refresh skill runs it to build the Job List and the News Digest, and the Tune skill to read skip
 * patterns and show a settings diff.
 */
import { validateDocument } from "../contract/index.ts";
import { runNewsCommand, type NewsIo } from "../refresh/news.ts";
import { runRefreshCommand } from "../refresh/run.ts";
import { runCheckResumes, type ResumeIo } from "./resumes.ts";
import { runSettingsDiff, runTuneReport } from "../tune/run.ts";

export interface CliIo extends NewsIo, ResumeIo {}

const USAGE = `Usage: jaa validate <collection> <doc-id> <file|->
       jaa refresh <dir> [--feed <url|file> | --rerun]
       jaa news plan <dir>
       jaa news build <dir>
       jaa check-resumes <manifest> [--settings <file|->]
       jaa tune-report <dir>
       jaa settings-diff <current-file> <proposed-file|->

validate       Checks one dashboard document (JSON, from a file or from stdin with -)
               against the dashboard contract. Exits 0 when it matches, 1 when it does not.
refresh        Builds the Job List from the dashboard state saved in <dir>/state and the
               Job Feed, and writes the documents and ArtifactData batches to <dir>/out.
               --rerun rebuilds from the Sources the last run read, without the network,
               applying the Resume Variant judgments in <dir>/variant-judgments.json.
news           After refresh, in the same <dir>: plan computes the hiring signals, lists
               the companies in the Queue and reads the forums (<dir>/out/news-plan.json);
               build joins them with the news gathered in <dir>/out/news-gathered.json into
               the day's News Digest and writes its batch to <dir>/out/news-writes.json.
check-resumes  Checks that every Resume Variant file the manifest lists is in the Candidate
               folder, and with --settings that the settings document names the same
               Resume Variants in the same order.
tune-report    Prints the settings, patterns in skip reasons with the changes they suggest,
               and the Job List's companies and apply sites, from the state saved in
               <dir>/state.
settings-diff  Checks a proposed settings document against the dashboard contract and
               prints every change from the current one. Writes nothing.
`;

/** Runs the CLI and resolves its exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (argv[0] === "refresh") {
    const [, dir, ...flags] = argv;
    const feed = flags[0] === "--feed" ? flags[1] : undefined;
    const rerun = flags.length === 1 && flags[0] === "--rerun";
    const valid = flags.length === 0 || rerun || (flags.length === 2 && feed !== undefined);
    if (!dir || dir.startsWith("--") || !valid) {
      io.stderr(USAGE);
      return 2;
    }
    return runRefreshCommand(dir, feed === undefined ? { rerun } : { feed }, io);
  }
  if (argv[0] === "check-resumes") {
    const [, manifest, ...flags] = argv;
    const settings = flags[0] === "--settings" ? flags[1] : undefined;
    const valid = flags.length === 0 || (flags.length === 2 && settings !== undefined);
    if (!manifest || manifest.startsWith("--") || !valid) {
      io.stderr(USAGE);
      return 2;
    }
    return runCheckResumes(manifest, settings, io);
  }
  if (argv[0] === "news") {
    const [, step, dir, ...rest] = argv;
    if ((step !== "plan" && step !== "build") || !dir || dir.startsWith("--") || rest.length > 0) {
      io.stderr(USAGE);
      return 2;
    }
    return runNewsCommand(step, dir, io);
  }
  if (argv[0] === "tune-report") {
    const [, dir, ...rest] = argv;
    if (!dir || dir.startsWith("--") || rest.length > 0) {
      io.stderr(USAGE);
      return 2;
    }
    return runTuneReport(dir, io);
  }
  if (argv[0] === "settings-diff") {
    const [, current, proposed, ...rest] = argv;
    if (!current || !proposed || current === "-" || rest.length > 0) {
      io.stderr(USAGE);
      return 2;
    }
    return runSettingsDiff(current, proposed, io);
  }
  const [command, collection, docId, file, ...rest] = argv;
  if (command !== "validate" || !collection || !docId || !file || rest.length > 0) {
    io.stderr(USAGE);
    return 2;
  }

  let text: string;
  try {
    text = file === "-" ? await io.readStdin() : await io.readFile(file);
  } catch (error) {
    io.stderr(`Could not read ${file}: ${messageOf(error)}\n`);
    return 1;
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    io.stderr(`The document is not valid JSON: ${messageOf(error)}\n`);
    return 1;
  }

  const result = validateDocument(collection, docId, document);
  if (result.ok) {
    io.stdout(`${collection}/${docId} matches the dashboard contract.\n`);
    return 0;
  }
  io.stderr(
    `${collection}/${docId} does not match the dashboard contract:\n` +
      result.issues.map((issue) => `- ${issue}\n`).join(""),
  );
  return 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
