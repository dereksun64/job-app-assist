import { describe, expect, it } from "vitest";
import type { Card, Posting, Referrals } from "../contract/index.ts";
import { samplePosting } from "../contract/testing/fixtures.ts";
import {
  MAX_REFERRAL_REVIEW,
  planReferrals,
  sameCompany,
  type Connection,
  type ReferralCalls,
  type ReferralInput,
} from "./referrals.ts";

const NOW = "2026-11-10T15:00:00.000Z";
const EARLIER = "2026-11-09T15:00:00.000Z";

function card(posting: Posting, stage: Card["stage"] = "queued"): Card {
  return {
    schemaVersion: 1,
    postingId: posting.id,
    stage,
    queuedAt: EARLIER,
    queuedBy: "refresh",
    posting,
    updatedAt: EARLIER,
  };
}

const datadog = samplePosting({
  id: "aaaaaaaaaaaa",
  company: "Datadog",
  title: "Software Engineer, New Grad",
  applyUrl: "https://careers.datadoghq.com/1",
});
const stripe = samplePosting({ id: "bbbbbbbbbbbb", company: "Stripe", title: "SWE Intern" });

const priya: Connection = {
  name: "Priya Shah",
  company: "Datadog",
  position: "Senior Software Engineer",
  connectedOn: "2024-11-08",
};
const omar: Connection = { name: "Omar Diaz", company: "Datadog, Inc.", connectedOn: "2025-06-01" };
const lena: Connection = {
  name: "Lena Ko",
  company: "Datadog",
  position: "University Recruiter",
  connectedOn: "2019-01-01",
};
const sam: Connection = { name: "Sam Lee", company: "Stripe", position: "Product Designer" };

function input(overrides: Partial<ReferralInput> = {}): ReferralInput {
  return {
    now: NOW,
    connections: [priya, omar, lena, sam],
    cards: [card(datadog), card(stripe)],
    cardIds: [datadog.id, stripe.id],
    current: new Map(),
    currentIds: [],
    calls: {},
    ...overrides,
  };
}

const message = (name: string) => `Hi ${name}, would you be open to referring me?`;

describe("sameCompany", () => {
  it.each([
    ["Datadog", "Datadog, Inc."],
    ["The Walt Disney Company", "Walt Disney"],
    ["Amazon", "Amazon Web Services (AWS)"],
    ["Google", "Alphabet Inc."],
  ])("matches %s and %s", (a, b) => {
    expect(sameCompany(a, b)).toBe(true);
    expect(sameCompany(b, a)).toBe(true);
  });

  it.each([
    ["Apple", "Applied Materials"],
    ["Google", "Waymo"],
    ["Meta", "Metabase"],
    ["", "Acme"],
  ])("tells %s and %s apart", (a, b) => {
    expect(sameCompany(a, b)).toBe(false);
  });
});

describe("planReferrals", () => {
  const datadogDraft = (name: string, connection: Connection) => ({
    name: connection.name,
    company: connection.company,
    ...(connection.position === undefined ? {} : { position: connection.position }),
    message: message(name),
  });

  it("does nothing when the Candidate has not imported connections", () => {
    const plan = planReferrals(input({ connections: undefined }));
    expect(plan).toEqual({
      set: [],
      delete: [],
      review: [],
      calls: {},
      summary: { imported: false, matches: 0, companies: 0, postings: 0, drafts: 0, toDraft: 0 },
    });
  });

  it("asks for a draft per connection at each queued company, recruiters first", () => {
    const plan = planReferrals(input());
    expect(plan.set).toEqual([]);
    expect(plan.review).toEqual([
      {
        key: "datadog",
        company: "Datadog",
        roles: [
          {
            title: "Software Engineer, New Grad",
            roleType: "Software Engineer",
            applyUrl: "https://careers.datadoghq.com/1",
          },
        ],
        connections: [lena, priya, omar],
      },
      {
        key: "stripe",
        company: "Stripe",
        roles: [{ title: "SWE Intern", roleType: "Software Engineer", applyUrl: stripe.applyUrl }],
        connections: [sam],
      },
    ]);
    expect(plan.summary).toEqual({
      imported: true,
      matches: 4,
      companies: 0,
      postings: 0,
      drafts: 0,
      toDraft: 4,
    });
  });

  it("asks each connection once per company, naming its best-ranked queued Postings", () => {
    const roles = [70, 95, 80, 60].map((score, i) =>
      samplePosting({
        id: String(i).repeat(12),
        company: i === 3 ? "Datadog, Inc." : "Datadog",
        title: `Role ${String(score)}`,
        score,
      }),
    );
    const plan = planReferrals(
      input({
        connections: [priya],
        cards: roles.map((p) => card(p)),
        cardIds: roles.map((p) => p.id),
      }),
    );
    expect(plan.review).toHaveLength(1);
    expect(plan.review[0]?.roles.map((r) => r.title)).toEqual(["Role 95", "Role 80", "Role 70"]);
    expect(plan.summary).toMatchObject({ matches: 1, toDraft: 1 });

    const drafted = planReferrals(
      input({
        connections: [priya],
        cards: roles.map((p) => card(p)),
        cardIds: roles.map((p) => p.id),
        calls: { datadog: { "Priya Shah": { message: message("Priya") } } },
      }),
    );
    expect(drafted.set.map((doc) => doc.postingId)).toEqual([
      "111111111111",
      "222222222222",
      "000000000000",
      "333333333333",
    ]);
    expect(new Set(drafted.set.map((doc) => JSON.stringify(doc.drafts))).size).toBe(1);
    expect(drafted.summary).toMatchObject({ companies: 1, postings: 4, drafts: 1, toDraft: 0 });
  });

  it("matches at most three connections per company, preferring the role's own field", () => {
    const more: Connection[] = [
      {
        name: "A One",
        company: "Datadog",
        position: "Account Executive",
        connectedOn: "2026-01-01",
      },
      { name: "B Two", company: "Datadog", position: "Software Engineer II" },
    ];
    const plan = planReferrals(
      input({ connections: [priya, omar, ...more], cards: [card(datadog)] }),
    );
    expect(plan.review[0]?.connections.map((c) => c.name)).toEqual([
      "Priya Shah",
      "B Two",
      "A One",
    ]);
  });

  it("writes the drafted messages for a queued Posting", () => {
    const calls: ReferralCalls = {
      datadog: {
        "Priya Shah": { message: message("Priya") },
        "Lena Ko": { message: message("Lena") },
      },
    };
    const plan = planReferrals(input({ calls }));
    expect(plan.set).toEqual<Referrals[]>([
      {
        schemaVersion: 1,
        postingId: datadog.id,
        drafts: [datadogDraft("Lena", lena), datadogDraft("Priya", priya)],
        updatedAt: NOW,
      },
    ]);
    expect(plan.review.flatMap((c) => c.connections.map((x) => x.name))).toEqual([
      "Omar Diaz",
      "Sam Lee",
    ]);
    expect(plan.summary).toMatchObject({ companies: 1, postings: 1, drafts: 2, toDraft: 2 });
  });

  it("drops a match the Refresh skill skipped and asks about the next connection instead", () => {
    const fourth: Connection = { name: "Dee Ray", company: "Datadog" };
    const calls: ReferralCalls = { datadog: { "Lena Ko": { skip: "Works at another Datadog." } } };
    const plan = planReferrals(
      input({ connections: [priya, omar, lena, fourth], cards: [card(datadog)], calls }),
    );
    expect(plan.review[0]?.connections.map((c) => c.name)).toEqual([
      "Priya Shah",
      "Omar Diaz",
      "Dee Ray",
    ]);
    expect(plan.calls).toEqual(calls);
  });

  it("leaves unchanged drafts alone, so a Refresh rewrites nothing it does not need to", () => {
    const calls: ReferralCalls = { stripe: { "Sam Lee": { message: message("Sam") } } };
    const current: Referrals = {
      schemaVersion: 1,
      postingId: stripe.id,
      drafts: [
        {
          message: message("Sam"),
          position: "Product Designer",
          company: "Stripe",
          name: "Sam Lee",
        },
      ],
      updatedAt: EARLIER,
    };
    const plan = planReferrals(
      input({ calls, current: new Map([[stripe.id, current]]), currentIds: [stripe.id] }),
    );
    expect(plan.set).toEqual([]);
    expect(plan.delete).toEqual([]);
    expect(plan.summary).toMatchObject({ postings: 1, drafts: 1 });
  });

  it("keeps drafts once the Posting has moved on from the Queue, and removes them when it has no card", () => {
    const current = (posting: Posting): Referrals => ({
      schemaVersion: 1,
      postingId: posting.id,
      drafts: [{ name: "X Y", company: posting.company, message: message("X") }],
      updatedAt: EARLIER,
    });
    const gone = samplePosting({ id: "cccccccccccc", company: "Gone" });
    const plan = planReferrals(
      input({
        connections: [],
        cards: [card(datadog, "submitted")],
        cardIds: [datadog.id],
        current: new Map([
          [datadog.id, current(datadog)],
          [gone.id, current(gone)],
        ]),
        currentIds: [datadog.id, gone.id, "dddddddddddd"],
      }),
    );
    expect(plan.set).toEqual([]);
    expect(plan.delete).toEqual([gone.id, "dddddddddddd"]);
  });

  it("removes a queued Posting's drafts when none of its connections match any more", () => {
    const current: Referrals = {
      schemaVersion: 1,
      postingId: stripe.id,
      drafts: [{ name: "Sam Lee", company: "Stripe", message: message("Sam") }],
      updatedAt: EARLIER,
    };
    const plan = planReferrals(
      input({
        connections: [priya],
        current: new Map([[stripe.id, current]]),
        currentIds: [stripe.id],
        calls: { stripe: { "Sam Lee": { message: message("Sam") } } },
      }),
    );
    expect(plan.delete).toEqual([stripe.id]);
    expect(plan.calls).toEqual({});
  });

  it("keeps only the calls that still apply", () => {
    const calls: ReferralCalls = {
      datadog: { "Priya Shah": { message: message("Priya") }, "Left Co": { skip: "Left." } },
      gone: { "Sam Lee": { message: message("Sam") } },
    };
    expect(planReferrals(input({ calls })).calls).toEqual({
      datadog: { "Priya Shah": { message: message("Priya") } },
    });
  });

  it("asks for a limited number of drafts per Refresh, best-ranked companies first", () => {
    const postings = Array.from({ length: 12 }, (_, i) =>
      samplePosting({
        id: i.toString(16).padStart(12, "0"),
        company: `Company ${String(i)}`,
        score: 90 - i,
      }),
    );
    const connections = postings.flatMap((p) =>
      ["A", "B", "C"].map((n) => ({ name: `${n} ${p.company}`, company: p.company })),
    );
    const plan = planReferrals(
      input({
        connections,
        cards: postings.map((p) => card(p)),
        cardIds: postings.map((p) => p.id),
      }),
    );
    expect(plan.review.flatMap((c) => c.connections)).toHaveLength(MAX_REFERRAL_REVIEW);
    expect(plan.review[0]?.company).toBe("Company 0");
    expect(plan.review.at(-1)?.connections).toHaveLength(MAX_REFERRAL_REVIEW % 3 || 3);
    expect(plan.summary.toDraft).toBe(36);
  });
});
