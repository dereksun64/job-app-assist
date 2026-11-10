// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { PAGE_SIZE } from "./PostingsTab.tsx";
import { createMemoryDb } from "./testing/memory-db.ts";
import { NOW, REFRESHED, jobListDocs, posting, settings } from "./testing/fixtures.ts";

const standard = [
  posting({
    company: "Acme",
    title: "Software Engineer, New Grad",
    score: 95,
    boosts: ["Fortune 500"],
    locations: ["New York, NY", "Boston, MA", "Austin, TX", "Seattle, WA"],
    sources: [
      { name: "Job Feed", list: "Simplify New Grad" },
      { name: "Job Feed", list: "Vansh New Grad" },
    ],
  }),
  posting({
    company: "Brainy",
    title: "Machine Learning Engineer Intern",
    roleType: "Machine Learning Engineer",
    level: "intern",
    locations: ["Remote in USA"],
    score: 70,
    postedOn: "2026-10-01",
    sources: [{ name: "Job Feed", list: "Vansh Internships" }],
  }),
  posting({
    company: "Charlie",
    title: "Backend Engineer",
    locations: ["Cambridge, MA"],
    locationTier: 2,
    score: 90,
    postedOn: "2026-11-10",
  }),
];

beforeEach(() => {
  window.location.hash = "#postings";
});

afterEach(() => {
  cleanup();
});

async function renderPostings(docs: Record<string, object> = jobListDocs(standard)) {
  const db = createMemoryDb({ "settings/main": settings, ...docs });
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("tablist");
  await act(() => Promise.resolve());
  return db;
}

const rows = () => [
  ...screen.getByRole("list", { name: "Job List" }).querySelectorAll<HTMLElement>(":scope > li"),
];
const companies = () => rows().map((row) => row.querySelector(".posting-company")?.textContent);

describe("Postings tab", () => {
  it("shows the ranked Job List in the order Refresh wrote it", async () => {
    await renderPostings();
    expect(companies()).toEqual(["Acme", "Brainy", "Charlie"]);
    const first = rows()[0];
    if (!first) throw new Error("no rows");
    expect(
      within(first).getByRole("link", { name: "Software Engineer, New Grad" }),
    ).toHaveAttribute("href", standard[0]?.applyUrl);
    expect(within(first).getByRole("link")).toHaveAttribute("target", "_blank");
    expect(first).toHaveTextContent("Rank 1");
    expect(first).toHaveTextContent("New York, NY; Boston, MA +2 more");
    expect(first).toHaveTextContent("Tier 1");
    expect(first).toHaveTextContent("New grad");
    expect(first).toHaveTextContent("2 days ago");
    expect(first).toHaveTextContent("Score 95");
    expect(first).toHaveTextContent("Fortune 500");
    expect(first).toHaveTextContent("Simplify New Grad, Vansh New Grad");
  });

  it("summarizes the Job List and when it was refreshed", async () => {
    await renderPostings(jobListDocs(standard, { matched: 1240 }));
    const panel = screen.getByRole("tabpanel", { name: "Postings" });
    expect(panel).toHaveTextContent("3 Postings in your Job List, the best of 1,240 matches.");
    expect(panel).toHaveTextContent("Refreshed Nov 10");
    expect(panel).toHaveTextContent("Showing all 3 Postings, best first");
  });

  it("reads a Job List split across pages, in page order", async () => {
    const many = Array.from({ length: 205 }, () => posting());
    await renderPostings(jobListDocs(many));
    expect(rows()).toHaveLength(PAGE_SIZE);
    expect(screen.getByRole("tabpanel", { name: "Postings" })).toHaveTextContent(
      "Showing all 205 Postings",
    );
  });

  it("shows more Postings on request", async () => {
    const user = userEvent.setup();
    await renderPostings(jobListDocs(Array.from({ length: 205 }, () => posting())));
    await user.click(screen.getByRole("button", { name: "Show 100 more" }));
    expect(rows()).toHaveLength(200);
    await user.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(rows()).toHaveLength(205);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
  });

  it("searches company, title and location text", async () => {
    const user = userEvent.setup();
    await renderPostings();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "machine remote");
    expect(companies()).toEqual(["Brainy"]);
    expect(screen.getByRole("tabpanel", { name: "Postings" })).toHaveTextContent(
      "Showing 1 Posting of 3",
    );
    await user.clear(screen.getByRole("searchbox", { name: "Search" }));
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "cambridge");
    expect(companies()).toEqual(["Charlie"]);
  });

  it("filters by role type, in the Search Profile's order", async () => {
    const user = userEvent.setup();
    await renderPostings();
    const select = screen.getByRole("combobox", { name: "Role type" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All role types", "Software Engineer", "Machine Learning Engineer"]);
    await user.selectOptions(select, "Machine Learning Engineer");
    expect(companies()).toEqual(["Brainy"]);
  });

  it("filters by Location Tier", async () => {
    const user = userEvent.setup();
    await renderPostings();
    await user.selectOptions(screen.getByRole("combobox", { name: "Location Tier" }), "Tier 2");
    expect(companies()).toEqual(["Charlie"]);
  });

  it("filters by Source and by the list inside it", async () => {
    const user = userEvent.setup();
    await renderPostings();
    const select = screen.getByRole("combobox", { name: "Source" });
    await user.selectOptions(select, "Vansh New Grad");
    expect(companies()).toEqual(["Acme"]);
    await user.selectOptions(select, "All of Job Feed");
    expect(companies()).toEqual(["Acme", "Brainy", "Charlie"]);
  });

  it("filters by freshness", async () => {
    const user = userEvent.setup();
    await renderPostings();
    await user.selectOptions(screen.getByRole("combobox", { name: "Posted" }), "Past day");
    expect(companies()).toEqual(["Charlie"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Posted" }), "Past week");
    expect(companies()).toEqual(["Acme", "Charlie"]);
  });

  it("says when no Posting matches and clears every filter at once", async () => {
    const user = userEvent.setup();
    await renderPostings();
    await user.selectOptions(screen.getByRole("combobox", { name: "Location Tier" }), "Tier 2");
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "nothing like this");
    expect(
      screen.getByRole("heading", { name: "No Postings match these filters" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(companies()).toEqual(["Acme", "Brainy", "Charlie"]);
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Location Tier" })).toHaveValue("");
  });

  it("reports a failing Source plainly", async () => {
    await renderPostings(
      jobListDocs(standard, {
        sources: [
          { name: "Job Feed", ok: false, postings: 0, error: "The Job Feed answered HTTP 503." },
        ],
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your Job List may be incomplete. The last Refresh couldn't read the Job Feed, so it kept the Postings found there before. The Job Feed answered HTTP 503.",
    );
  });

  it("explains an empty Job List after a Refresh", async () => {
    await renderPostings(jobListDocs([]));
    expect(
      screen.getByRole("heading", { name: "No Postings matched your Search Profile" }),
    ).toBeInTheDocument();
  });

  it("keeps the last complete Job List while a Refresh is still writing pages", async () => {
    const db = await renderPostings();
    const newer = "2026-11-11T14:30:00.000Z";
    await act(() =>
      db.doc("postings/page-1").set({
        schemaVersion: 1,
        refreshedAt: newer,
        page: 1,
        postings: [posting({ company: "Delta" })],
      }),
    );
    expect(companies()).toEqual(["Acme", "Brainy", "Charlie"]);
    expect(screen.getByRole("status")).toHaveTextContent("Refresh is updating your Job List");
    await act(() =>
      db.doc("postings/meta").set({ ...jobListDocs([posting()], {}, newer)["postings/meta"] }),
    );
    expect(companies()).toEqual(["Delta"]);
    expect(screen.queryByText("Refresh is updating your Job List…")).toBeNull();
  });

  it("waits for the first Refresh to finish writing", async () => {
    const docs = jobListDocs(standard);
    delete docs["postings/page-1"];
    await renderPostings(docs);
    expect(screen.getByRole("status")).toHaveTextContent("Refresh is writing your Job List.");
  });

  it("explains a Job List that breaks the contract", async () => {
    const docs = jobListDocs(standard);
    docs["postings/page-1"] = {
      schemaVersion: 1,
      refreshedAt: REFRESHED,
      page: 1,
      postings: [{ id: "bad" }],
    };
    await renderPostings(docs);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Your Job List doesn't match what this dashboard expects");
    expect(alert).toHaveTextContent("postings/page-1: postings.0");
  });

  it("writes nothing to the database", async () => {
    const user = userEvent.setup();
    const db = await renderPostings();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "acme");
    await user.selectOptions(screen.getByRole("combobox", { name: "Posted" }), "Past month");
    expect(db.writes).toEqual([]);
  });
});
