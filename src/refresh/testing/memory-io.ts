import { resolve } from "node:path";
import type { Fetch } from "../job-feed.ts";
import type { NewsIo } from "../news.ts";

export type MemoryIo = NewsIo & { out: string; err: string; disk: Map<string, string> };

/** A file system in memory for adapter tests; paths resolve against the working directory. */
export function memoryIo(
  files: Record<string, string>,
  { fetch, now, timeZone = "UTC" }: { fetch?: Fetch; now: string; timeZone?: string },
): MemoryIo {
  const disk = new Map(Object.entries(files).map(([path, text]) => [resolve(path), text]));
  const io: MemoryIo = {
    out: "",
    err: "",
    disk,
    readFile: (path) => {
      const text = disk.get(resolve(path));
      return text === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(text);
    },
    writeFile: (path, text) => {
      disk.set(resolve(path), text);
      return Promise.resolve();
    },
    readDir: (path) => {
      const prefix = `${resolve(path)}/`;
      return Promise.resolve(
        [...disk.keys()]
          .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .map((p) => p.slice(prefix.length)),
      );
    },
    makeDir: () => Promise.resolve(),
    removeDir: (path) => {
      for (const key of [...disk.keys()]) if (key.startsWith(`${resolve(path)}/`)) disk.delete(key);
      return Promise.resolve();
    },
    fetch: fetch ?? (() => Promise.reject(new Error("no network in tests"))),
    now: () => now,
    timeZone: () => timeZone,
    sleep: () => Promise.resolve(),
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
  };
  return io;
}
