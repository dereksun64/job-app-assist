/** What Fill's commands need from the outside world; tests pass an in-memory version. */
export interface FillIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** The names in a directory, or none when it does not exist. */
  readDir(path: string): Promise<string[]>;
  makeDir(path: string): Promise<void>;
  /** The size in bytes of a regular file, or undefined when there is none at `path`. */
  fileSize(path: string): Promise<number | undefined>;
  now(): string;
  env(name: string): string | undefined;
  homeDir(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** A problem the skill can fix; the command prints its message and exits 1. */
export class FillError extends Error {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
