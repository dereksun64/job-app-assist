// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AddedByUrlSource,
  JobListMeta,
  JobListPage,
  Posting,
  Settings,
  WatchlistSource,
} from "../contract/index.ts";
import { App } from "./App.tsx";
import { NOW, posting as fixturePosting, settings as fixtureSettings } from "./testing/fixtures.ts";
import { createMemoryDb, type MemoryDb } from "./testing/memory-db.ts";

const NOW_ISO = new Date(NOW).toISOString();
/** Earlier on the same day as NOW, after the Postings below were added. */
const REFRESHED = "2026-11-10T08:00:00.000Z";

const settings: Settings = {
  ...fixtureSettings,
  searchProfile: {
    ...fixtureSettings.searchProfile,
    seniority: ["new_grad"],
    locationTiers: [{ locations: ["New York City"] }],
  },
};

const watchlist: WatchlistSource = {
  schemaVersion: 1,
  enabled: true,
  companies: [
    { name: "Stripe", board: "greenhouse", slug: "stripe" },
    { name: "Ramp", board: "ashby", slug: "ramp" },
  ],
  updatedAt: "2026-11-05T00:00:00.000Z",
};

const added: AddedByUrlSource = {
  schemaVersion: 1,
  enabled: true,
  postings: [
    {
      url: "https://runway.example.com/jobs/42",
      company: "Tiny Startup",
      title: "Software Engineer",
      location: "New York, NY",
      addedAt: "2026-11-07T09:30:00.000Z",
    },
  ],
  updatedAt: "2026-11-07T09:30:00.000Z",
};

function posting(overrides: Partial<Posting>): Posting {
  return fixturePosting({
    applyUrl: "https://job-boards.greenhouse.io/stripe/jobs/1",
    company: "Stripe",
    sources: [{ name: "Watchlist", list: "Stripe" }],
    ...overrides,
  });
}

function jobList(postings: Posting[], sources: JobListMeta["sources"]) {
  const page: JobListPage = { schemaVersion: 1, refreshedAt: REFRESHED, page: 1, postings };
  const meta: JobListMeta = {
    schemaVersion: 1,
    refreshedAt: REFRESHED,
    pageCount: postings.length === 0 ? 0 : 1,
    total: postings.length,
    matched: postings.length,
    sources,
  };
  return postings.length === 0
    ? { "postings/meta": meta }
    : { "postings/page-1": page, "postings/meta": meta };
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
});

async function openPanel(docs: Record<string, object> = {}): Promise<MemoryDb> {
  const db = createMemoryDb({ "settings/main": settings, ...docs });
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("tablist");
  await act(() => Promise.resolve());
  await userEvent.click(screen.getByRole("button", { name: "Sources" }));
  return db;
}

const panel = () => screen.getByRole("dialog", { name: "Sources" });
const region = (name: string) => within(panel()).getByRole("region", { name });

describe("Sources panel", () => {
  it("opens from the tab bar with every Source on by default", async () => {
    await openPanel();
    expect(panel()).toBeVisible();
    for (const name of ["Job Feed", "Watchlist", "Add by URL"]) {
      expect(within(panel()).getByRole("switch", { name })).toBeChecked();
    }
    expect(region("Watchlist")).toHaveTextContent("No companies on your watchlist yet.");
    expect(region("Add by URL")).toHaveTextContent("Nothing added yet.");
  });

  it("closes with its close button and keeps the page as it was", async () => {
    window.location.hash = "#postings";
    await openPanel();
    await userEvent.click(within(panel()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Sources" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Postings" })).toHaveAttribute("aria-selected", "true");
  });

  it("switches a Source off and stores its switch", async () => {
    const db = await openPanel();
    const jobFeed = within(panel()).getByRole("switch", { name: "Job Feed" });
    await userEvent.click(jobFeed);
    expect(db.writes).toEqual([
      {
        op: "set",
        path: "sources/job-feed",
        data: { schemaVersion: 1, enabled: false, updatedAt: NOW_ISO },
      },
    ]);
    expect(jobFeed).not.toBeChecked();
    expect(region("Job Feed")).toHaveTextContent("Off. Your next Refresh skips the Job Feed.");

    await userEvent.click(jobFeed);
    expect(db.contents()["sources/job-feed"]).toMatchObject({ enabled: true });
    expect(jobFeed).toBeChecked();
  });

  it("keeps the watchlist when it is switched off", async () => {
    const db = await openPanel({ "sources/watchlist": watchlist });
    await userEvent.click(within(panel()).getByRole("switch", { name: "Watchlist" }));
    expect(db.contents()["sources/watchlist"]).toEqual({
      ...watchlist,
      enabled: false,
      updatedAt: NOW_ISO,
    });
  });

  it("shows the Source documents already saved", async () => {
    await openPanel({
      "sources/job-feed": { schemaVersion: 1, enabled: false, updatedAt: NOW_ISO },
      "sources/watchlist": watchlist,
      "sources/added-by-url": added,
    });
    expect(within(panel()).getByRole("switch", { name: "Job Feed" })).not.toBeChecked();
    const companies = within(region("Watchlist")).getAllByRole("listitem");
    expect(companies.map((li) => within(li).getByRole("heading").textContent)).toEqual([
      "Stripe",
      "Ramp",
    ]);
    expect(
      within(region("Watchlist")).getByRole("link", { name: "Greenhouse: stripe" }),
    ).toHaveAttribute("href", "https://job-boards.greenhouse.io/stripe");
    expect(
      within(region("Add by URL")).getByRole("link", { name: "Software Engineer" }),
    ).toHaveAttribute("href", "https://runway.example.com/jobs/42");
  });
});

describe("watchlist editor", () => {
  it("adds a company from its job board link, naming it from the link", async () => {
    const db = await openPanel();
    const editor = region("Watchlist");
    await userEvent.type(
      within(editor).getByLabelText("Job board link"),
      "https://jobs.lever.co/palantir",
    );
    expect(within(editor).getByLabelText("Company")).toHaveAttribute("placeholder", "Palantir");
    await userEvent.click(within(editor).getByRole("button", { name: "Add company" }));

    expect(db.writes).toEqual([
      {
        op: "set",
        path: "sources/watchlist",
        data: {
          schemaVersion: 1,
          enabled: true,
          companies: [{ name: "Palantir", board: "lever", slug: "palantir" }],
          updatedAt: NOW_ISO,
        },
      },
    ]);
    expect(within(editor).getByRole("heading", { name: "Palantir" })).toBeVisible();
    expect(within(editor).getByText("Read on your next Refresh")).toBeVisible();
    expect(within(editor).getByLabelText("Job board link")).toHaveValue("");
  });

  it("uses the company name the Candidate typed, and any link into the board", async () => {
    const db = await openPanel({ "sources/watchlist": watchlist });
    const editor = region("Watchlist");
    await userEvent.type(
      within(editor).getByLabelText("Job board link"),
      "https://jobs.ashbyhq.com/openai/8fb1615c/application",
    );
    await userEvent.type(within(editor).getByLabelText("Company"), "OpenAI");
    await userEvent.keyboard("{Enter}");
    expect(db.contents()["sources/watchlist"]).toMatchObject({
      companies: [...watchlist.companies, { name: "OpenAI", board: "ashby", slug: "openai" }],
    });
  });

  it("explains a link that is not a Greenhouse, Lever or Ashby job board", async () => {
    const db = await openPanel();
    const editor = region("Watchlist");
    await userEvent.type(
      within(editor).getByLabelText("Job board link"),
      "https://stripe.com/jobs",
    );
    await userEvent.click(within(editor).getByRole("button", { name: "Add company" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Paste a link to the company's job board on Greenhouse, Lever or Ashby, such as https://jobs.lever.co/palantir.",
    );
    expect(within(editor).getByLabelText("Job board link")).toHaveAttribute("aria-invalid", "true");
    expect(db.writes).toEqual([]);
  });

  it("refuses a job board already on the watchlist", async () => {
    const db = await openPanel({ "sources/watchlist": watchlist });
    const editor = region("Watchlist");
    await userEvent.type(
      within(editor).getByLabelText("Job board link"),
      "https://boards.greenhouse.io/Stripe/jobs/123",
    );
    await userEvent.click(within(editor).getByRole("button", { name: "Add company" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent(
      "Stripe is already on your watchlist.",
    );
    expect(db.writes).toEqual([]);
  });

  it("removes a company", async () => {
    const db = await openPanel({ "sources/watchlist": watchlist });
    await userEvent.click(
      within(region("Watchlist")).getByRole("button", { name: "Remove Stripe" }),
    );
    expect(db.contents()["sources/watchlist"]).toMatchObject({
      companies: [{ name: "Ramp", board: "ashby", slug: "ramp" }],
    });
    expect(within(region("Watchlist")).queryByRole("heading", { name: "Stripe" })).toBeNull();
  });

  it("shows what the last Refresh read from each company", async () => {
    await openPanel({
      "sources/watchlist": watchlist,
      ...jobList(
        [
          posting({ id: "000000000001" }),
          posting({
            id: "000000000002",
            applyUrl: "https://job-boards.greenhouse.io/stripe/jobs/2",
          }),
        ],
        [
          { name: "Watchlist", list: "Stripe", ok: true, postings: 41 },
          {
            name: "Watchlist",
            list: "Ramp",
            ok: false,
            postings: 0,
            error: "Ramp has no public Ashby job board at https://jobs.ashbyhq.com/ramp.",
          },
        ],
      ),
    });
    const [stripe, ramp] = within(region("Watchlist")).getAllByRole("listitem");
    expect(stripe).toHaveTextContent("41 open jobs, 2 in your Job List");
    expect(ramp).toHaveTextContent(
      "The last Refresh couldn't read this board. Ramp has no public Ashby job board at https://jobs.ashbyhq.com/ramp.",
    );
  });
});

describe("Add by URL", () => {
  async function fill(fields: Record<string, string>) {
    const box = region("Add by URL");
    for (const [label, value] of Object.entries(fields)) {
      await userEvent.type(within(box).getByLabelText(label), value);
    }
    await userEvent.click(within(box).getByRole("button", { name: "Add Posting" }));
  }

  it("adds a Posting with its details, to join the Job List on the next Refresh", async () => {
    const db = await openPanel();
    await fill({
      "Posting link": "https://runway.example.com/jobs/77",
      Company: "Tiny Startup",
      Title: "Founding Engineer",
      Location: "New York City",
    });
    expect(db.writes).toEqual([
      {
        op: "set",
        path: "sources/added-by-url",
        data: {
          schemaVersion: 1,
          enabled: true,
          postings: [
            {
              url: "https://runway.example.com/jobs/77",
              company: "Tiny Startup",
              title: "Founding Engineer",
              location: "New York City",
              addedAt: NOW_ISO,
            },
          ],
          updatedAt: NOW_ISO,
        },
      },
    ]);
    const item = within(region("Add by URL")).getByRole("listitem");
    expect(item).toHaveTextContent("Founding Engineer");
    expect(item).toHaveTextContent("Tiny Startup · New York City");
    expect(item).toHaveTextContent("Joins your Job List on the next Refresh");
    expect(within(region("Add by URL")).getByLabelText("Posting link")).toHaveValue("");
  });

  it("suggests the company from a Greenhouse, Lever or Ashby link", async () => {
    const db = await openPanel();
    await fill({
      "Posting link": "https://job-boards.greenhouse.io/figma/jobs/5551234",
      Title: "Software Engineer, Early Career",
      Location: "San Francisco",
    });
    expect(db.contents()["sources/added-by-url"]).toMatchObject({
      postings: [{ company: "Figma", url: "https://job-boards.greenhouse.io/figma/jobs/5551234" }],
    });
  });

  it("asks for each missing detail before adding", async () => {
    const db = await openPanel();
    await fill({ "Posting link": "https://runway.example.com/jobs/77" });
    const box = region("Add by URL");
    expect(within(box).getByRole("alert")).toHaveTextContent(
      "Add the company, the title and the location, so Refresh can rank this Posting.",
    );
    expect(within(box).getByLabelText("Company")).toHaveAttribute("aria-invalid", "true");
    expect(db.writes).toEqual([]);
  });

  it("explains a link that is not a web address", async () => {
    const db = await openPanel();
    await fill({ "Posting link": "tiny startup", Company: "A", Title: "B", Location: "C" });
    expect(within(region("Add by URL")).getByRole("alert")).toHaveTextContent(
      "Paste the Posting's full link, starting with https://.",
    );
    expect(db.writes).toEqual([]);
  });

  it("refuses a Posting already added, however its link is written", async () => {
    const db = await openPanel({ "sources/added-by-url": added });
    await fill({
      "Posting link": "https://runway.example.com/jobs/42/?utm_source=newsletter",
      Company: "Tiny Startup",
      Title: "Software Engineer",
      Location: "New York, NY",
    });
    expect(within(region("Add by URL")).getByRole("alert")).toHaveTextContent(
      "You already added this Posting.",
    );
    expect(db.writes).toEqual([]);
  });

  it("removes an added Posting", async () => {
    const db = await openPanel({ "sources/added-by-url": added });
    await userEvent.click(
      within(region("Add by URL")).getByRole("button", {
        name: "Remove Software Engineer at Tiny Startup",
      }),
    );
    expect(db.contents()["sources/added-by-url"]).toMatchObject({ postings: [] });
    expect(region("Add by URL")).toHaveTextContent("Nothing added yet.");
  });

  it("shows whether each added Posting made the Job List", async () => {
    await openPanel({
      "sources/added-by-url": {
        ...added,
        postings: [
          ...added.postings,
          {
            url: "https://jobs.lever.co/far/1",
            company: "Far Away",
            title: "Software Engineer",
            location: "Denver, CO",
            addedAt: "2026-11-07T09:30:00.000Z",
          },
        ],
      },
      ...jobList(
        [
          posting({
            company: "Tiny Startup",
            applyUrl: "https://runway.example.com/jobs/42",
            sources: [{ name: "Added by URL" }],
          }),
        ],
        [{ name: "Added by URL", ok: true, postings: 2 }],
      ),
    });
    const [inList, leftOut] = within(region("Add by URL")).getAllByRole("listitem");
    expect(inList).toHaveTextContent("In your Job List");
    expect(leftOut).toHaveTextContent(
      "Not in your Job List: it doesn't match your Search Profile.",
    );
  });
});

describe("saving Sources", () => {
  it("says plainly when a change could not be saved", async () => {
    const db = createMemoryDb(
      { "settings/main": settings },
      { failWritesWith: { code: "quota_exceeded", message: "Storage is full" } },
    );
    render(<App db={db} pageVersion="1.2.3" now={NOW} />);
    await screen.findByRole("tablist");
    await act(() => Promise.resolve());
    await userEvent.click(screen.getByRole("button", { name: "Sources" }));
    await userEvent.click(within(panel()).getByRole("switch", { name: "Job Feed" }));
    expect(within(panel()).getByRole("alert")).toHaveTextContent(
      "Your dashboard storage is full, so this change wasn't saved. To make room, ask your Claude to run /job-app-assist:tidy.",
    );
    expect(within(panel()).getByRole("switch", { name: "Job Feed" })).toBeChecked();
  });

  it("reports a Source document that does not match the contract, with that Source off", async () => {
    await openPanel({ "sources/watchlist": { ...watchlist, enabled: "yes" } });
    expect(within(panel()).getByRole("alert")).toHaveTextContent(
      "Your Sources don't match what this dashboard expects",
    );
    expect(within(panel()).getByRole("switch", { name: "Watchlist" })).not.toBeChecked();
  });
});
