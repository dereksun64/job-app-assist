import { describe, expect, it } from "vitest";
import { moveCard, moveCardByEmail, type Card, type Posting } from "../contract/index.ts";
import { samplePosting } from "../contract/testing/fixtures.ts";
import {
  classifyEmail,
  followUps,
  gmailSearchPlan,
  planGmailMoves,
  type Email,
  type GmailJudgment,
} from "./gmail.ts";

const NOW = "2026-11-10T15:00:00.000Z";
const QUEUED = "2026-10-20T12:00:00.000Z";

let next = 0;
function card(company: string, overrides: Partial<Card> = {}, posting: Partial<Posting> = {}) {
  next += 1;
  const id = next.toString(16).padStart(12, "0");
  const value: Card = {
    schemaVersion: 1,
    postingId: id,
    stage: "submitted",
    queuedAt: QUEUED,
    queuedBy: "refresh",
    stageChangedAt: "2026-10-22T12:00:00.000Z",
    posting: samplePosting({
      id,
      company,
      applyUrl: `https://job-boards.greenhouse.io/${company.toLowerCase()}/jobs/${String(next)}`,
      ...posting,
    }),
    updatedAt: QUEUED,
    ...overrides,
  };
  return value;
}

let mail = 0;
function email(overrides: Partial<Email> = {}): Email {
  mail += 1;
  return {
    id: `msg-${String(mail)}`,
    from: "Acme Recruiting <recruiting@acme.com>",
    receivedAt: "2026-11-05T14:00:00.000Z",
    subject: "Thank you for applying to Acme",
    snippet: "We have received your application for Software Engineer, New Grad.",
    ...overrides,
  };
}

function plan(emails: Email[], cards: Card[], judgments: Record<string, GmailJudgment> = {}) {
  return planGmailMoves({ emails, cards, judgments, now: NOW });
}

describe("classifyEmail", () => {
  it.each([
    ["confirmation", "Thank you for applying to Acme", "We received your application."],
    ["confirmation", "Application received: Software Engineer", ""],
    ["assessment", "Complete your HackerRank assessment for Acme", ""],
    ["assessment", "Acme online assessment", "Please finish the coding challenge within 7 days."],
    ["interview", "Acme interview invitation", ""],
    ["interview", "Next steps with Acme", "We'd like to schedule a phone screen with you."],
    ["offer", "Your offer from Acme", ""],
    ["offer", "Great news", "We are pleased to offer you the position of Software Engineer."],
    [
      "rejection",
      "Update on your application",
      "Unfortunately, we have decided to move forward with other candidates.",
    ],
    ["rejection", "Your application to Acme", "We regret to inform you that the role is filled."],
  ] as const)("reads a %s email: %s", (kind, subject, snippet) => {
    expect(classifyEmail({ subject, snippet })).toEqual({ kind, kinds: [kind] });
  });

  it("lets any later step win over the thanks for applying that comes with it", () => {
    expect(
      classifyEmail({
        subject: "Thank you for applying to Acme",
        snippet: "Unfortunately, we will not be moving forward with your application.",
      }),
    ).toEqual({ kind: "rejection", kinds: ["rejection"] });
    expect(
      classifyEmail({
        subject: "Thanks for your application",
        snippet: "As a next step, please complete the CodeSignal assessment.",
      }),
    ).toEqual({ kind: "assessment", kinds: ["assessment"] });
  });

  it("leaves an email that reads two ways for Claude to judge", () => {
    expect(
      classifyEmail({
        subject: "Your interview with Acme",
        snippet: "Unfortunately we need to reschedule.",
      }),
    ).toEqual({ kinds: ["interview", "rejection"] });
  });

  it("does not take a benefits line or a job alert for news about an application", () => {
    expect(
      classifyEmail({ subject: "Life at Acme", snippet: "We offer competitive benefits." }),
    ).toEqual({ kinds: [] });
    expect(
      classifyEmail({
        subject: "New jobs at Acme you may be interested in",
        snippet: "Schedule an interview today!",
      }),
    ).toEqual({ kinds: [], alert: true });
  });
});

describe("planGmailMoves", () => {
  it("moves a card when the company's own domain sends a clear email", () => {
    const acme = card("Acme", { stage: "ready_for_review" });
    const confirmation = email();
    const result = plan([confirmation], [acme]);
    expect(result.moves).toEqual([
      {
        emailId: confirmation.id,
        postingId: acme.postingId,
        company: "Acme",
        title: acme.posting.title,
        from: "ready_for_review",
        to: "submitted",
        by: "rules",
        evidence: {
          company: "Acme",
          receivedAt: confirmation.receivedAt,
          subject: confirmation.subject,
        },
      },
    ]);
    expect(result.cards.get(acme.postingId)).toEqual(
      moveCardByEmail(
        acme,
        "submitted",
        { company: "Acme", receivedAt: confirmation.receivedAt, subject: confirmation.subject },
        NOW,
      ),
    );
    expect(result.review).toEqual([]);
  });

  it("never carries the email's text beyond its subject onto the card", () => {
    const acme = card("Acme");
    const rejection = email({
      subject: "Your application",
      snippet: "Unfortunately, we have decided to move forward with other candidates. Sam",
    });
    const moved = plan([rejection], [acme]).cards.get(acme.postingId);
    expect(moved).toMatchObject({ stage: "closed", closedReason: "rejected" });
    expect(JSON.stringify(moved)).not.toContain("Unfortunately");
  });

  it("shortens a very long subject to fit the card", () => {
    const acme = card("Acme");
    const long = email({ subject: `Interview invitation ${"x".repeat(400)}` });
    const moved = plan([long], [acme]).cards.get(acme.postingId);
    const subject = moved?.stageEvidence?.[0]?.subject ?? "";
    expect(subject.length).toBe(300);
    expect(subject.endsWith("…")).toBe(true);
  });

  it.each([
    ["the sender's name", "Brainy <no-reply@us.greenhouse-mail.io>", "Thank you for applying"],
    ["the subject", "no-reply@ashbyhq.com", "Thanks for applying to Brainy"],
    ["the subject", "Hiring Team <noreply@hackerrank.com>", "Brainy has invited you to a test"],
  ])("matches an email an application site sends by %s", (_, from, subject) => {
    const brainy = card("Brainy Labs, Inc.");
    const result = plan(
      [email({ from, subject, snippet: "Please complete the online assessment." })],
      [brainy],
    );
    expect(result.moves.map((m) => m.postingId)).toEqual([brainy.postingId]);
  });

  it("matches the sender's domain to a company's own application site", () => {
    const delta = card("Delta Air Lines", {}, { applyUrl: "https://careers.delta.com/job/123" });
    const result = plan(
      [email({ from: "talent@delta.com", subject: "Interview invitation" })],
      [delta],
    );
    expect(result.moves.map((m) => m.to)).toEqual(["interviewing"]);
  });

  it("only moves a card forward, and never moves a Closed card", () => {
    const interviewing = card("Acme", { stage: "interviewing" });
    const closed = card("Brainy", { stage: "closed", closedReason: "withdrawn" });
    const result = plan(
      [
        email({ subject: "Thank you for applying to Acme" }),
        email({ from: "jobs@brainy.com", subject: "Interview invitation" }),
      ],
      [interviewing, closed],
    );
    expect(result.moves).toEqual([]);
    expect(result.review).toEqual([]);
    expect(result.counts.noChange).toBe(2);
  });

  it("follows several emails in order of arrival", () => {
    const acme = card("Acme", { stage: "ready_for_review" });
    const interview = email({ subject: "Acme interview invitation", receivedAt: NOW });
    const thanks = email({ receivedAt: "2026-11-01T10:00:00.000Z" });
    const result = plan([interview, thanks], [acme]);
    expect(result.moves.map((m) => m.to)).toEqual(["submitted", "interviewing"]);
    expect(result.cards.get(acme.postingId)?.stageEvidence?.map((e) => e.stage)).toEqual([
      "submitted",
      "interviewing",
    ]);
  });

  it("does not use an email twice, even after the Candidate undid its move", () => {
    const rejection = email({ subject: "Your application", snippet: "Unfortunately, no." });
    const facts = { company: "Acme", receivedAt: rejection.receivedAt, subject: rejection.subject };
    const closed = moveCardByEmail(card("Acme"), "closed", facts, "2026-11-06T10:00:00.000Z");
    const undone = moveCard(closed, "submitted", "2026-11-07T10:00:00.000Z");
    const result = plan([rejection], [undone]);
    expect(result.moves).toEqual([]);
    expect(result.counts.alreadyRecorded).toBe(1);
  });

  it("ignores emails from well before the card was queued", () => {
    const acme = card("Acme", { queuedAt: "2026-11-01T00:00:00.000Z" });
    const old = email({ subject: "Unfortunately", receivedAt: "2026-10-01T00:00:00.000Z" });
    expect(plan([old], [acme]).moves).toEqual([]);
  });

  it("leaves emails from companies without a card alone", () => {
    const result = plan(
      [email({ from: "jobs@zeta.com", subject: "Thanks for applying to Zeta" })],
      [card("Acme")],
    );
    expect(result).toMatchObject({ moves: [], review: [], counts: { unmatched: 1 } });
  });

  it("picks the card whose title the email names when a company has several", () => {
    const swe = card("Acme", {}, { title: "Software Engineer, New Grad" });
    const ml = card("Acme", {}, { title: "Machine Learning Engineer Intern" });
    const result = plan(
      [email({ subject: "Interview: Machine Learning Engineer Intern", snippet: "" })],
      [swe, ml],
    );
    expect(result.moves.map((m) => m.postingId)).toEqual([ml.postingId]);
  });

  describe("emails left for Claude to judge", () => {
    it("lists an email that could be either of two cards", () => {
      const swe = card("Acme", {}, { title: "Software Engineer, New Grad" });
      const ml = card("Acme", {}, { title: "Machine Learning Engineer Intern" });
      const interview = email({ subject: "Interview invitation", snippet: "Pick a time." });
      const result = plan([interview], [swe, ml]);
      expect(result.moves).toEqual([]);
      expect(result.review).toEqual([
        {
          emailId: interview.id,
          from: interview.from,
          receivedAt: interview.receivedAt,
          subject: interview.subject,
          snippet: interview.snippet,
          kinds: ["interview"],
          why: "It could be about 2 cards at Acme.",
          cards: [swe, ml].map((c) => ({
            postingId: c.postingId,
            company: "Acme",
            title: c.posting.title,
            stage: "submitted",
          })),
        },
      ]);
    });

    it("lists an email that reads two ways", () => {
      const result = plan(
        [email({ subject: "Your interview with Acme", snippet: "Unfortunately we must move it." })],
        [card("Acme")],
      );
      expect(result.review.map((r) => [r.kinds, r.why])).toEqual([
        [["interview", "rejection"], "It reads as more than one kind of email."],
      ]);
    });

    it("lists an email from a matched company that says nothing the rules know", () => {
      const result = plan(
        [email({ subject: "Quick question", snippet: "Are you free?" })],
        [card("Acme")],
      );
      expect(result.review.map((r) => [r.kinds, r.why])).toEqual([
        [[], "The rules could not tell what kind of email it is."],
      ]);
    });

    it("lists an email that only names the company in passing", () => {
      const result = plan(
        [email({ from: "news@techdigest.io", subject: "Acme interview tips", snippet: "" })],
        [card("Acme")],
      );
      expect(result.review.map((r) => r.why)).toEqual([
        "Only the subject or text names Acme; the sender is not Acme or an application site.",
      ]);
    });

    it("skips job alerts", () => {
      const result = plan(
        [email({ subject: "Jobs you may be interested in at Acme", snippet: "" })],
        [card("Acme")],
      );
      expect(result.review).toEqual([]);
      expect(result.counts.alerts).toBe(1);
    });

    it("applies Claude's judgment and records it as the reason for the move", () => {
      const swe = card("Acme", {}, { title: "Software Engineer, New Grad" });
      const ml = card("Acme", {}, { title: "Machine Learning Engineer Intern" });
      const interview = email({ subject: "Interview invitation", snippet: "" });
      const result = plan([interview], [swe, ml], {
        [interview.id]: { postingId: ml.postingId, kind: "interview" },
      });
      expect(result.moves).toMatchObject([{ postingId: ml.postingId, by: "judgment" }]);
      expect(result.review).toEqual([]);
    });

    it("drops an email Claude judged unrelated", () => {
      const quick = email({ subject: "Quick question", snippet: "" });
      const result = plan([quick], [card("Acme")], { [quick.id]: { ignore: true } });
      expect(result).toMatchObject({ moves: [], review: [], counts: { judged: 1 } });
    });

    it("still moves only forward on Claude's judgment", () => {
      const acme = card("Acme", { stage: "offer" });
      const quick = email({ subject: "Quick question", snippet: "" });
      const result = plan([quick], [acme], {
        [quick.id]: { postingId: acme.postingId, kind: "interview" },
      });
      expect(result.moves).toEqual([]);
    });
  });
});

describe("gmailSearchPlan", () => {
  it("searches for every company with an open card since shortly before the oldest was queued", () => {
    const result = gmailSearchPlan(
      [
        card("Acme", { queuedAt: "2026-10-20T12:00:00.000Z" }),
        card("Brainy Labs", { queuedAt: "2026-11-01T12:00:00.000Z" }),
        card("Acme"),
        card("Closed Co", { stage: "closed", closedReason: "rejected" }),
      ],
      NOW,
    );
    expect(result).toEqual({
      since: "2026-10-13",
      companies: ["Acme", "Brainy Labs"],
      queries: [
        'after:2026/10/13 (Acme OR "Brainy Labs") (application OR applying OR applied OR interview OR assessment OR offer OR unfortunately OR candidacy OR "next steps")',
      ],
    });
  });

  it("looks back at most 90 days", () => {
    expect(
      gmailSearchPlan([card("Acme", { queuedAt: "2025-01-01T00:00:00.000Z" })], NOW).since,
    ).toBe("2026-08-12");
  });

  it("splits many companies across several searches", () => {
    const cards = Array.from({ length: 31 }, (_, i) => card(`Company${String(i)}`));
    expect(gmailSearchPlan(cards, NOW).queries).toHaveLength(3);
  });

  it("has nothing to search for without open cards", () => {
    expect(gmailSearchPlan([], NOW)).toEqual({ since: undefined, companies: [], queries: [] });
  });
});

describe("followUps", () => {
  it("lists Submitted cards with no reply in 14 days, longest waiting first", () => {
    const old = card("Acme", { stageChangedAt: "2026-10-01T00:00:00.000Z" });
    const older = card("Brainy", { stageChangedAt: "2026-09-20T00:00:00.000Z" });
    const recent = card("Charlie", { stageChangedAt: "2026-11-01T00:00:00.000Z" });
    expect(followUps([old, recent, older], NOW).map((c) => c.posting.company)).toEqual([
      "Brainy",
      "Acme",
    ]);
  });
});
