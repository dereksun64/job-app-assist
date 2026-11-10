// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Posting } from "../contract/index.ts";
import { App } from "./App.tsx";
import {
  NOW,
  REFRESHED,
  cardDoc,
  daysAgo,
  jobListDocs,
  posting,
  settings,
  skipDoc,
} from "./testing/fixtures.ts";
import { createMemoryDb, type MemoryDbOptions } from "./testing/memory-db.ts";

const acme = posting({ company: "Acme", title: "Software Engineer, New Grad" });
const brainy = posting({ company: "Brainy", title: "Machine Learning Engineer Intern" });
const charlie = posting({ company: "Charlie", title: "Backend Engineer", locationTier: 2 });
const delta = posting({ company: "Delta", title: "Platform Engineer" });
const list = [acme, brainy, charlie, delta];
const NOW_ISO = new Date(NOW).toISOString();

beforeEach(() => {
  window.location.hash = "#postings";
});

afterEach(() => {
  cleanup();
});

async function renderPostings(docs: Record<string, object> = {}, options?: MemoryDbOptions) {
  const db = createMemoryDb({ "settings/main": settings, ...jobListDocs(list), ...docs }, options);
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("list", { name: "Job List" });
  await act(() => Promise.resolve());
  return db;
}

const rows = () => [
  ...screen.getByRole("list", { name: "Job List" }).querySelectorAll<HTMLElement>(":scope > li"),
];
const companies = () => rows().map((row) => row.querySelector(".posting-company")?.textContent);
const rowOf = (company: string) => {
  const row = rows().find((r) => r.querySelector(".posting-company")?.textContent === company);
  if (!row) throw new Error(`no row for ${company}`);
  return row;
};
const tickOf = (company: string) => within(rowOf(company)).getByRole("checkbox");
const queueBar = () => screen.getByRole("region", { name: "Queue" });
const settle = () => act(() => Promise.resolve());

describe("ticking Postings into the Queue", () => {
  it("shows queued Postings ticked and highlighted, the rest unticked", async () => {
    await renderPostings({ ...cardDoc(acme), ...cardDoc(charlie) });
    expect(tickOf("Acme")).toBeChecked();
    expect(tickOf("Brainy")).not.toBeChecked();
    expect(tickOf("Charlie")).toBeChecked();
    expect(tickOf("Acme")).toHaveAccessibleName(
      "In your Queue: Software Engineer, New Grad at Acme",
    );
    expect(rowOf("Acme")).toHaveClass("posting-queued");
    expect(rowOf("Brainy")).not.toHaveClass("posting-queued");
  });

  it("adds a Posting to the Queue with one click", async () => {
    const user = userEvent.setup();
    const db = await renderPostings();
    await user.click(tickOf("Brainy"));
    await settle();
    expect(db.writes).toEqual([
      {
        op: "set",
        path: `cards/${brainy.id}`,
        data: {
          schemaVersion: 1,
          postingId: brainy.id,
          stage: "queued",
          queuedAt: NOW_ISO,
          queuedBy: "candidate",
          posting: brainy,
          updatedAt: NOW_ISO,
        },
      },
    ]);
    expect(tickOf("Brainy")).toBeChecked();
    expect(rowOf("Brainy")).toHaveClass("posting-queued");
    expect(queueBar()).toHaveTextContent("1 Posting in your Queue");
  });

  it("asks for a skip reason on untick and records it in skips", async () => {
    const user = userEvent.setup();
    const db = await renderPostings(cardDoc(acme));
    await user.click(tickOf("Acme"));
    const prompt = screen.getByRole("group", { name: "Why skip Software Engineer, New Grad?" });
    expect(
      within(prompt)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Wrong role",
      "Wrong location",
      "Wrong company",
      "Too senior",
      "Other reason",
      "Keep in Queue",
    ]);
    expect(within(prompt).getByRole("button", { name: "Wrong role" })).toHaveFocus();
    expect(db.writes).toEqual([]);

    await user.click(within(prompt).getByRole("button", { name: "Wrong location" }));
    await settle();
    expect(db.writes).toEqual([
      {
        op: "set",
        path: `skips/${acme.id}`,
        data: {
          schemaVersion: 1,
          postingId: acme.id,
          reason: "wrong_location",
          skippedAt: NOW_ISO,
          posting: acme,
        },
      },
      { op: "delete", path: `cards/${acme.id}` },
    ]);
    expect(companies()).toEqual(["Brainy", "Charlie", "Delta"]);
    expect(queueBar()).toHaveTextContent("0 Postings in your Queue");
  });

  it("keeps a Posting queued when the skip is called off", async () => {
    const user = userEvent.setup();
    const db = await renderPostings(cardDoc(acme));
    await user.click(tickOf("Acme"));
    await user.click(screen.getByRole("button", { name: "Keep in Queue" }));
    expect(screen.queryByRole("group", { name: /^Why skip/ })).toBeNull();
    expect(tickOf("Acme")).toBeChecked();
    expect(tickOf("Acme")).toHaveFocus();

    await user.click(tickOf("Acme"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /^Why skip/ })).toBeNull();
    expect(tickOf("Acme")).toBeChecked();
    expect(db.writes).toEqual([]);
  });

  it("shows a Posting past the queued Stage by its Stage, without a tick to undo", async () => {
    await renderPostings(cardDoc(acme, { stage: "submitted" }));
    expect(within(rowOf("Acme")).queryByRole("checkbox")).toBeNull();
    expect(rowOf("Acme")).toHaveTextContent("Submitted");
    expect(queueBar()).toHaveTextContent("0 Postings in your Queue");
  });

  it("says so when a change can't be saved", async () => {
    const user = userEvent.setup();
    await renderPostings(
      {},
      { failWritesWith: { code: "quota_exceeded", message: "Database quota exceeded" } },
    );
    await user.click(tickOf("Brainy"));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your dashboard storage is full, so that change wasn't saved.",
    );
    expect(tickOf("Brainy")).not.toBeChecked();
  });
});

describe("Show filter", () => {
  it("shows only queued Postings, including one that left the Job List", async () => {
    const user = userEvent.setup();
    const gone = posting({ company: "Echo", title: "Gone Engineer" });
    await renderPostings({ ...cardDoc(charlie), ...cardDoc(gone) });
    expect(companies()).toEqual(["Acme", "Brainy", "Charlie", "Delta", "Echo"]);

    await user.click(screen.getByRole("radio", { name: "Queued 2" }));
    expect(companies()).toEqual(["Charlie", "Echo"]);
    expect(rowOf("Echo")).toHaveTextContent("No longer in your Job List");
    expect(rowOf("Echo")).not.toHaveTextContent("Rank");
    expect(screen.getByRole("tabpanel", { name: "Postings" })).toHaveTextContent(
      "Showing 2 Postings of 4",
    );
  });

  it("hides skipped Postings and shows them, with their reason, behind a filter", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...skipDoc(brainy, { reason: "too_senior" }), ...skipDoc(delta) });
    expect(companies()).toEqual(["Acme", "Charlie"]);

    await user.click(screen.getByRole("radio", { name: "Skipped 2" }));
    expect(companies()).toEqual(["Brainy", "Delta"]);
    expect(rowOf("Brainy")).toHaveTextContent("Skipped: too senior");
    expect(rowOf("Delta")).toHaveTextContent("Skipped: wrong location");
  });

  it("un-skips a Posting so it returns to the Job List", async () => {
    const user = userEvent.setup();
    const db = await renderPostings(skipDoc(brainy));
    await user.click(screen.getByRole("radio", { name: "Skipped 1" }));
    await user.click(within(rowOf("Brainy")).getByRole("button", { name: "Un-skip" }));
    await settle();
    expect(db.writes).toEqual([{ op: "delete", path: `skips/${brainy.id}` }]);
    await user.click(screen.getByRole("radio", { name: /^All/ }));
    expect(companies()).toEqual(["Acme", "Brainy", "Charlie", "Delta"]);
    expect(tickOf("Brainy")).not.toBeChecked();
  });

  it("queues a skipped Posting straight from the Skipped filter", async () => {
    const user = userEvent.setup();
    const db = await renderPostings(skipDoc(brainy));
    await user.click(screen.getByRole("radio", { name: "Skipped 1" }));
    await user.click(tickOf("Brainy"));
    await settle();
    expect(db.writes.map((w) => `${w.op} ${w.path}`)).toEqual([
      `set cards/${brainy.id}`,
      `delete skips/${brainy.id}`,
    ]);
    await user.click(screen.getByRole("radio", { name: "Queued 1" }));
    expect(companies()).toEqual(["Brainy"]);
  });

  it("combines with the other filters and clears with them", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...cardDoc(acme), ...cardDoc(charlie) });
    await user.click(screen.getByRole("radio", { name: "Queued 2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Location Tier" }), "Tier 2");
    expect(companies()).toEqual(["Charlie"]);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(companies()).toEqual(["Acme", "Brainy", "Charlie", "Delta"]);
    expect(screen.getByRole("radio", { name: /^All/ })).toBeChecked();
  });
});

describe("Queue footer", () => {
  it("shows the Queue count against the daily target and links to the board", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...cardDoc(acme), ...cardDoc(brainy) });
    expect(queueBar()).toHaveTextContent("2 Postings in your Queue");
    expect(queueBar()).toHaveTextContent("Daily target 20");
    const link = within(queueBar()).getByRole("link", { name: "Open the Progress board" });
    expect(link).toHaveAttribute("href", "#progress");
    await user.click(link);
    expect(await screen.findByRole("tabpanel", { name: "Progress" })).toBeInTheDocument();
  });
});

describe("carry-over", () => {
  function queuedFor(of: Posting, days: number) {
    return cardDoc(of, { queuedAt: daysAgo(days), updatedAt: daysAgo(days) });
  }

  it("badges how long an unsubmitted item has waited and flags five days as possibly closed", async () => {
    await renderPostings({
      ...cardDoc(acme, { queuedAt: REFRESHED }),
      ...queuedFor(brainy, 1),
      ...queuedFor(charlie, 4.9),
      ...queuedFor(delta, 5),
    });
    expect(rowOf("Acme")).not.toHaveTextContent("in Queue");
    expect(rowOf("Brainy")).toHaveTextContent("1 day in Queue");
    expect(rowOf("Charlie")).toHaveTextContent("4 days in Queue");
    expect(rowOf("Charlie")).not.toHaveTextContent("Possibly closed");
    expect(rowOf("Delta")).toHaveTextContent("5 days in Queue");
    expect(rowOf("Delta")).toHaveTextContent("Possibly closed");
    expect(queueBar()).toHaveTextContent("1 possibly closed");
  });
});
