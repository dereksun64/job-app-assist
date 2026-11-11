/**
 * Token use per application. Claude Code records every model response of a session, with its
 * token usage, in a transcript under the Claude config folder. Fill notes when it starts and
 * finishes a Posting, and this sums the session's usage between the two, including subagents.
 */
import { join } from "node:path";
import type { FillIo } from "./io.ts";

export interface TokenUsage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** All four kinds added up. */
  total: number;
  /** How many model responses the window holds. */
  messages: number;
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** The transcripts of this Claude Code session: the main one and its subagents'. */
async function transcripts(io: FillIo, session: string): Promise<string[]> {
  const config = io.env("CLAUDE_CONFIG_DIR") ?? join(io.homeDir(), ".claude");
  const projects = join(config, "projects");
  const found: string[] = [];
  for (const project of await io.readDir(projects)) {
    const main = join(projects, project, `${session}.jsonl`);
    if ((await io.fileSize(main)) === undefined) continue;
    found.push(main);
    const subagents = join(projects, project, session, "subagents");
    for (const name of await io.readDir(subagents)) {
      if (name.endsWith(".jsonl")) found.push(join(subagents, name));
    }
  }
  return found;
}

interface Entry {
  type?: unknown;
  timestamp?: unknown;
  message?: { id?: unknown; usage?: Record<string, unknown> };
}

const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);

/**
 * The session's token usage from `from` to `to` (ISO timestamps), or undefined when the
 * session or its transcript cannot be found.
 */
export async function sessionUsage(
  io: FillIo,
  from: string,
  to: string,
): Promise<TokenUsage | undefined> {
  const session = io.env("CLAUDE_CODE_SESSION_ID");
  if (session === undefined || !SESSION_ID.test(session)) return undefined;
  const files = await transcripts(io, session);
  if (files.length === 0) return undefined;

  const start = Date.parse(from);
  const end = Date.parse(to);
  const seen = new Set<string>();
  const usage: TokenUsage = {
    input: 0,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
    total: 0,
    messages: 0,
  };
  for (const file of files) {
    const text = await io.readFile(file).catch(() => "");
    for (const line of text.split("\n")) {
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (entry.type !== "assistant" || typeof entry.timestamp !== "string") continue;
      const at = Date.parse(entry.timestamp);
      if (!(at >= start && at <= end)) continue;
      const id = entry.message?.id;
      const tokens = entry.message?.usage;
      if (typeof id !== "string" || !tokens || seen.has(id)) continue;
      seen.add(id);
      usage.input += count(tokens.input_tokens);
      usage.cacheCreation += count(tokens.cache_creation_input_tokens);
      usage.cacheRead += count(tokens.cache_read_input_tokens);
      usage.output += count(tokens.output_tokens);
      usage.messages += 1;
    }
  }
  usage.total = usage.input + usage.cacheCreation + usage.cacheRead + usage.output;
  return usage;
}
