import { resolve } from "node:path";
import type { FillIo } from "../io.ts";

export type MemoryFillIo = FillIo & { out: string; err: string; disk: Map<string, string> };

/**
 * A file system in memory for Fill's adapter tests. Paths resolve against the working
 * directory, which stands in for the Candidate folder; `now` can move between calls.
 */
export function memoryFillIo(
  files: Record<string, string>,
  {
    now,
    env = {},
    home = "/home/candidate",
  }: { now: string; env?: Record<string, string>; home?: string },
): MemoryFillIo & { setNow(at: string): void } {
  const disk = new Map(Object.entries(files).map(([path, text]) => [resolve(path), text]));
  let clock = now;
  const io: MemoryFillIo & { setNow(at: string): void } = {
    out: "",
    err: "",
    disk,
    setNow: (at) => {
      clock = at;
    },
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
      const names = new Set<string>();
      for (const key of disk.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0] ?? "");
      }
      return Promise.resolve([...names].sort());
    },
    makeDir: () => Promise.resolve(),
    fileSize: (path) => {
      const text = disk.get(resolve(path));
      return Promise.resolve(text === undefined ? undefined : Buffer.byteLength(text));
    },
    now: () => clock,
    env: (name) => env[name],
    homeDir: () => home,
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
  };
  return io;
}
