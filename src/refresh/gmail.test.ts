import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Card, Posting, Settings } from "../contract/index.ts";
import { samplePosting } from "../contract/testing/fixtures.ts";
import type { Email, GmailReviewItem } from "../engine/gmail.ts";
import { runGmailCommand, type GmailPlanFile } from "./gmail.ts";
import type { BatchWrite } from "./run.ts";
import { memoryIo, type MemoryIo } from "./testing/memory-io.ts";

const NOW = "2026-11-10T15:00:00.000Z";
const dir = "candidate/.job-app-assist/refresh";
const at = (...parts: string[]) => join(resolve(dir), ...parts);
const file = (...parts: string[]) => `${dir}/${parts.join("/")}`;

const settings = (gmailTracking?: boolean): Settings => ({
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [{ name: "Software Engineer", priority: "high" }],
    seniority: ["new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["Remote"] }],
  },
  resumeVariants: [{ name: "Generalist SWE", roleTypes: [], keywords: [] }],
  dailyQueueTarget: 20,
  companies: { boost: [], lower: [], block: [] },
  blockedApplySites: [],
  freshnessWeight: 20,
  ...(gmailTracking === undefined ? {} : { gmailTracking }),
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const acme = samplePosting({ id: "00000000000a", company: "Acme" });
const brainy = samplePosting({ id: "00000000000b", company: "Brainy" });
const charlie = samplePosting({ id: "00000000000c", company: "Charlie" });

function card(of: Posting, overrides: Partial<Card> = {}): Card {
  return {
    schemaVersion: 1,
    postingId: of.id,
    stage: "submitted",
    queuedAt: "2026-10-20T12:00:00.000Z",
    queuedBy: "refresh",
    stageChangedAt: "2026-11-01T12:00:00.000Z",
    posting: of,
    updatedAt: "2026-11-01T12:00:00.000Z",
    ...overrides,
  };
}

function state(gmailTracking: boolean | undefined, cards: Card[]): Record<string, string> {
  const files: Record<string, string> = {
    [file("state/settings/main.json")]: JSON.stringify(settings(gmailTracking)),
  };
  for (const c of cards) files[file("state/cards", `${c.postingId}.json`)] = JSON.stringify(c);
  return files;
}

const interview: Email = {
  id: "msg-1",
  from: "Acme Recruiting <recruiting@acme.com>",
  receivedAt: "2026-11-09T14:00:00.000Z",
  subject: "Acme interview invitation",
  snippet: "Hi Sam, we'd love to set up a call with you next week.",
};
const unsure: Email = {
  id: "msg-2",
  from: "Brainy <talent@brainy.com>",
  receivedAt: "2026-11-09T15:00:00.000Z",
  subject: "Quick question",
  snippet: "Are you free on Thursday?",
};

// Parsed JSON is cast to the shape each test expects.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function readOut<T>(io: MemoryIo, ...parts: string[]): T {
  const text = io.disk.get(at(...parts));
  if (text === undefined) throw new Error(`missing ${parts.join("/")}`);
  return JSON.parse(text) as T;
}

describe("jaa gmail plan", () => {
  it("skips Gmail when the Candidate has not opted in, and still lists follow-ups", async () => {
    const old = card(charlie, { stageChangedAt: "2026-10-20T12:00:00.000Z" });
    const io = memoryIo(state(false, [card(acme), old]), { now: NOW });
    expect(await runGmailCommand("plan", dir, io)).toBe(0);
    expect(readOut<GmailPlanFile>(io, "out", "gmail-plan.json")).toEqual({
      tracking: "off",
      since: undefined,
      companies: [],
      queries: [],
    });
    expect(io.out).toContain("Gmail tracking is off, so skip reading Gmail.");
    expect(io.out).toContain(
      "Follow up: 1 Submitted card has had no reply in 14 days or more:\n- Charlie, Software Engineer, New Grad: Submitted since Oct 20.",
    );
  });

  it("says when the Candidate has not chosen yet", async () => {
    const io = memoryIo(state(undefined, [card(acme)]), { now: NOW });
    expect(await runGmailCommand("plan", dir, io)).toBe(0);
    expect(readOut<GmailPlanFile>(io, "out", "gmail-plan.json").tracking).toBe("unset");
    expect(io.out).toContain("has not chosen whether Refresh reads their Gmail");
  });

  it("gives the searches to run when the Candidate opted in", async () => {
    const io = memoryIo(state(true, [card(acme), card(brainy)]), { now: NOW });
    expect(await runGmailCommand("plan", dir, io)).toBe(0);
    const plan = readOut<GmailPlanFile>(io, "out", "gmail-plan.json");
    expect(plan).toMatchObject({
      tracking: "on",
      since: "2026-10-13",
      companies: ["Acme", "Brainy"],
    });
    expect(io.out).toContain(plan.queries[0]);
    expect(io.out).toContain("Follow up: none.");
  });
});

describe("jaa gmail match", () => {
  function setup(emails: unknown[], extra: Record<string, string> = {}) {
    return memoryIo(
      {
        ...state(true, [card(acme), card(brainy)]),
        [file("versions.json")]: JSON.stringify({
          "cards/00000000000a": 3,
          "cards/00000000000b": 1,
        }),
        [file("out/gmail-gathered.json")]: JSON.stringify({ emails }),
        ...extra,
      },
      { now: NOW },
    );
  }

  it("writes the moved cards with their versions, keeping only company, date and subject", async () => {
    const io = setup([interview]);
    expect(await runGmailCommand("match", dir, io)).toBe(0);
    const { batches } = readOut<{ batches: BatchWrite[][] }>(io, "out", "gmail-writes.json");
    expect(batches).toEqual([
      [
        {
          op: "set",
          collection: "cards",
          doc_id: "00000000000a",
          file_path: at("out", "gmail-cards", "00000000000a.json"),
          if_version: 3,
        },
      ],
    ]);
    const moved = readOut<Card>(io, "out", "gmail-cards", "00000000000a.json");
    expect(moved).toMatchObject({
      stage: "interviewing",
      stageChangedAt: NOW,
      stageEvidence: [
        {
          company: "Acme",
          receivedAt: interview.receivedAt,
          subject: interview.subject,
          stage: "interviewing",
          movedAt: NOW,
        },
      ],
    });
    expect(io.disk.get(at("out", "gmail-cards", "00000000000a.json"))).not.toContain("Sam");
    expect(io.out).toContain(
      'Moved 1 card:\n- Acme, Software Engineer, New Grad: Submitted to Interviewing, by "Acme interview invitation" (Nov 9).',
    );
  });

  it("lists unsure emails for review, and applies the judgments saved for them", async () => {
    const io = setup([interview, unsure]);
    expect(await runGmailCommand("match", dir, io)).toBe(0);
    const { review } = readOut<{ review: GmailReviewItem[] }>(io, "out", "gmail-review.json");
    expect(review.map((r) => r.emailId)).toEqual(["msg-2"]);
    expect(io.out).toContain(
      `Unsure: 1 email for you to judge, listed in ${at("out", "gmail-review.json")}.`,
    );

    io.disk.set(
      at("gmail-judgments.json"),
      JSON.stringify({
        "msg-2": { postingId: "00000000000b", kind: "interview" },
        old: { ignore: true },
      }),
    );
    expect(await runGmailCommand("match", dir, io)).toBe(0);
    expect(readOut<{ review: GmailReviewItem[] }>(io, "out", "gmail-review.json").review).toEqual(
      [],
    );
    expect(
      readOut<{ batches: BatchWrite[][] }>(io, "out", "gmail-writes.json").batches[0],
    ).toHaveLength(2);
    // Judgments for emails no longer found are dropped, so the file does not grow forever.
    expect(readOut<Record<string, unknown>>(io, "gmail-judgments.json")).toEqual({
      "msg-2": { postingId: "00000000000b", kind: "interview" },
    });
  });

  it("names a moved card whose version was not saved", async () => {
    const io = setup([interview], { [file("versions.json")]: "{}" });
    expect(await runGmailCommand("match", dir, io)).toBe(1);
    expect(io.err).toContain("versions.json has no version for cards/00000000000a");
  });

  it("names the emails that are not in the expected shape", async () => {
    const io = setup([
      { ...interview, receivedAt: "yesterday" },
      { ...unsure, body: "full text" },
    ]);
    expect(await runGmailCommand("match", dir, io)).toBe(1);
    expect(io.err).toContain("emails.0.receivedAt: must be an ISO 8601 timestamp");
    expect(io.err).toContain('emails.1: Unrecognized key: "body"');
  });

  it("refuses a judgment about a card that is not on the board", async () => {
    const io = setup([unsure], {
      [file("gmail-judgments.json")]: JSON.stringify({
        "msg-2": { postingId: "ffffffffffff", kind: "offer" },
      }),
    });
    expect(await runGmailCommand("match", dir, io)).toBe(1);
    expect(io.err).toContain("msg-2 names the card ffffffffffff, which is not on the board");
  });

  it("writes nothing when no email moves a card", async () => {
    const io = setup([]);
    expect(await runGmailCommand("match", dir, io)).toBe(0);
    expect(readOut<{ batches: BatchWrite[][] }>(io, "out", "gmail-writes.json").batches).toEqual(
      [],
    );
    expect(io.out).toContain("Moved no cards.");
    expect(io.out).toContain("Nothing to write to the dashboard.");
  });

  it("refuses to run when the Candidate has not opted in", async () => {
    const io = memoryIo(state(false, []), { now: NOW });
    expect(await runGmailCommand("match", dir, io)).toBe(1);
    expect(io.err).toContain("Gmail tracking is off");
  });
});
