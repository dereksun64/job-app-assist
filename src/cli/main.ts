import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { runCli } from "./jaa.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
  readDir: (path) => readdir(path).catch(() => []),
  makeDir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  fetch: (url, init) => fetch(url, init),
  now: () => new Date().toISOString(),
  readStdin: () => text(process.stdin),
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
});
