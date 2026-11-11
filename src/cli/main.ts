import { homedir } from "node:os";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
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
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  readStdin: () => text(process.stdin),
  fileSize: (path) =>
    stat(path).then(
      (info) => (info.isFile() ? info.size : undefined),
      () => undefined,
    ),
  env: (name) => process.env[name],
  homeDir: () => homedir(),
  // Bundled as <plugin>/dist/jaa.mjs, so the plugin's folder is one up.
  pluginRoot: () => fileURLToPath(new URL("..", import.meta.url)),
  platform: () => process.platform,
  nodeVersion: () => process.versions.node,
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
});
