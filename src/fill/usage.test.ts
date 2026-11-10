import { describe, expect, it } from "vitest";
import { sessionUsage } from "./usage.ts";
import { memoryFillIo } from "./testing/memory-io.ts";

const SESSION = "79cf49e9-2df2-4bb0-9731-1030b02554f7";

function assistant(
  id: string,
  timestamp: string,
  usage: Record<string, number>,
  extra: object = {},
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { id, role: "assistant", usage },
    ...extra,
  });
}

const u = (input: number, created: number, read: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: output,
});

const transcript = [
  JSON.stringify({
    type: "user",
    timestamp: "2026-11-10T15:00:30.000Z",
    message: { role: "user" },
  }),
  assistant("msg_before", "2026-11-10T14:59:59.000Z", u(1, 1, 1, 1)),
  // Claude Code writes one line per content block, each repeating the message's usage.
  assistant("msg_a", "2026-11-10T15:00:01.000Z", u(2, 100, 1000, 50)),
  assistant("msg_a", "2026-11-10T15:00:02.000Z", u(2, 100, 1000, 50)),
  assistant("msg_b", "2026-11-10T15:03:00.000Z", u(3, 200, 2000, 70)),
  "not json",
  assistant("msg_after", "2026-11-10T15:10:00.001Z", u(9, 9, 9, 9)),
].join("\n");

const subagent = assistant("msg_sub", "2026-11-10T15:05:00.000Z", u(1, 10, 100, 5));

const projects = "/home/candidate/.claude/projects";

describe("sessionUsage", () => {
  it("sums the session's tokens between two moments, counting each message once", async () => {
    const io = memoryFillIo(
      {
        [`${projects}/-Users-sam-jobs/${SESSION}.jsonl`]: transcript,
        [`${projects}/-Users-sam-jobs/${SESSION}/subagents/agent-1.jsonl`]: subagent,
        [`${projects}/-Users-sam-other/other.jsonl`]: assistant(
          "x",
          "2026-11-10T15:01:00.000Z",
          u(5, 5, 5, 5),
        ),
      },
      { now: "2026-11-10T15:10:00.000Z", env: { CLAUDE_CODE_SESSION_ID: SESSION } },
    );
    expect(await sessionUsage(io, "2026-11-10T15:00:00.000Z", "2026-11-10T15:10:00.000Z")).toEqual({
      input: 6,
      cacheCreation: 310,
      cacheRead: 3100,
      output: 125,
      total: 3541,
      messages: 3,
    });
  });

  it("reads the Claude config folder from CLAUDE_CONFIG_DIR when it is set", async () => {
    const io = memoryFillIo(
      { [`/cfg/projects/p/${SESSION}.jsonl`]: transcript },
      {
        now: "2026-11-10T15:10:00.000Z",
        env: { CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: "/cfg" },
      },
    );
    const usage = await sessionUsage(io, "2026-11-10T15:00:00.000Z", "2026-11-10T15:10:00.000Z");
    expect(usage?.messages).toBe(2);
  });

  it("is undefined without a session id or a transcript", async () => {
    const files = { [`${projects}/p/${SESSION}.jsonl`]: transcript };
    const noSession = memoryFillIo(files, { now: "2026-11-10T15:10:00.000Z" });
    expect(
      await sessionUsage(noSession, "2026-11-10T15:00:00.000Z", "2026-11-10T15:10:00.000Z"),
    ).toBeUndefined();
    const noTranscript = memoryFillIo(
      {},
      {
        now: "2026-11-10T15:10:00.000Z",
        env: { CLAUDE_CODE_SESSION_ID: SESSION },
      },
    );
    expect(
      await sessionUsage(noTranscript, "2026-11-10T15:00:00.000Z", "2026-11-10T15:10:00.000Z"),
    ).toBeUndefined();
  });

  it("refuses a session id that is not a plain id", async () => {
    const io = memoryFillIo(
      { [`${projects}/p/x.jsonl`]: transcript },
      {
        now: "2026-11-10T15:10:00.000Z",
        env: { CLAUDE_CODE_SESSION_ID: "../p/x" },
      },
    );
    expect(
      await sessionUsage(io, "2026-11-10T15:00:00.000Z", "2026-11-10T15:10:00.000Z"),
    ).toBeUndefined();
  });
});
