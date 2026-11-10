/**
 * `jaa`: the Toolkit's command-line entry point, bundled into plugin/dist/jaa.mjs.
 * Skills run it to check a document against the dashboard contract before writing it.
 */
import { validateDocument } from "../contract/index.ts";

export interface CliIo {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `Usage: jaa validate <collection> <doc-id> <file|->

Checks one dashboard document (JSON, from a file or from stdin with -)
against the dashboard contract. Exits 0 when it matches, 1 when it does not.
`;

/** Runs the CLI and resolves its exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(USAGE);
    return 0;
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
