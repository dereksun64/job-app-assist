import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { runCli } from "./jaa.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  readFile: (path) => readFile(path, "utf8"),
  readStdin: () => text(process.stdin),
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
});
