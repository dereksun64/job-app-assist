/**
 * `jaa`: the Toolkit's command-line entry point, bundled into plugin/dist/jaa.mjs.
 * Skills run it to check a document against the dashboard contract before writing it, and the
 * Refresh skill runs it to build the Job List.
 */
import { validateDocument } from "../contract/index.ts";
import { runRefreshCommand, type RefreshIo } from "../refresh/run.ts";

export interface CliIo extends RefreshIo {
  readStdin(): Promise<string>;
}

const USAGE = `Usage: jaa validate <collection> <doc-id> <file|->
       jaa refresh <dir> [--feed <url|file>]

validate  Checks one dashboard document (JSON, from a file or from stdin with -)
          against the dashboard contract. Exits 0 when it matches, 1 when it does not.
refresh   Builds the Job List from the dashboard state saved in <dir>/state and the
          Job Feed, and writes the documents and ArtifactData batches to <dir>/out.
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
    const valid = flags.length === 0 || (flags.length === 2 && feed !== undefined);
    if (!dir || dir.startsWith("--") || !valid) {
      io.stderr(USAGE);
      return 2;
    }
    return runRefreshCommand(dir, feed === undefined ? {} : { feed }, io);
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
