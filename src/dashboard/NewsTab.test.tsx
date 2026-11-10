// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { NewsTab } from "./NewsTab.tsx";
import { sampleSignal } from "../contract/testing/fixtures.ts";
import { NOW, newsDoc, settings } from "./testing/fixtures.ts";
import { createMemoryDb, type MemoryDbOptions } from "./testing/memory-db.ts";

beforeEach(() => {
  window.location.hash = "#news";
});

afterEach(() => {
  cleanup();
});

async function renderNews(docs: Record<string, object> = {}, options?: MemoryDbOptions) {
  const db = createMemoryDb({ "settings/main": settings, ...docs }, options);
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("tablist");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  return db;
}

const panel = () => screen.getByRole("tabpanel", { name: "News" });
const section = (name: string) => within(panel()).getByRole("region", { name });

describe("News tab", () => {
  it("shows the newest News Digest first, with the day it was built for", async () => {
    await renderNews({
      ...newsDoc("2026-11-08"),
      ...newsDoc("2026-11-10"),
      ...newsDoc("2026-11-09"),
    });
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Tuesday, November 10, 2026",
    );
    expect(panel()).toHaveTextContent("42 Postings in your Job List went up this week");
  });

  it("shows the four sections in order", async () => {
    await renderNews(newsDoc("2026-11-10"));
    expect(
      within(panel())
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Hiring signals", "Forum highlights", "Company news", "Industry news"]);
  });

  it("links each hiring signal's Postings to where the Candidate applies", async () => {
    await renderNews(newsDoc("2026-11-10"));
    const signals = section("Hiring signals");
    expect(signals).toHaveTextContent("Acme");
    expect(signals).toHaveTextContent("Fortune 500");
    expect(signals).toHaveTextContent("2 new Postings this week");
    const link = within(signals).getByRole("link", { name: "Software Engineer, New Grad" });
    expect(link).toHaveAttribute("href", "https://job-boards.greenhouse.io/acme/jobs/123");
    expect(signals).toHaveTextContent("New grad");
    expect(signals).toHaveTextContent("Posted Nov 8");
  });

  it("points to the Postings tab for a signal's Postings it does not list", async () => {
    await renderNews(newsDoc("2026-11-10"));
    const signals = section("Hiring signals");
    expect(signals).toHaveTextContent("and 1 more on the Postings tab");
    expect(within(signals).getByRole("link", { name: "Postings tab" })).toHaveAttribute(
      "href",
      "#postings",
    );
  });

  it("shows the five strongest signals first and the rest on request", async () => {
    const user = userEvent.setup();
    const signals = ["A", "B", "C", "D", "E", "F", "G"].map((company) => sampleSignal({ company }));
    await renderNews(newsDoc("2026-11-10", { hiringSignals: signals }));
    const companies = () =>
      [...section("Hiring signals").querySelectorAll(".signal-company")].map((e) => e.textContent);
    expect(companies()).toEqual(["A", "B", "C", "D", "E"]);
    await user.click(
      within(section("Hiring signals")).getByRole("button", { name: "Show 2 more companies" }),
    );
    expect(companies()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(within(section("Hiring signals")).queryByRole("button")).toBeNull();
  });

  it("links every forum highlight to its thread, labeled by forum", async () => {
    await renderNews(newsDoc("2026-11-10"));
    const forums = section("Forum highlights");
    expect(
      within(forums).getByRole("link", { name: "New grad offers this cycle" }),
    ).toHaveAttribute("href", "https://www.reddit.com/r/csMajors/comments/abc123/new_grad_offers/");
    expect(forums).toHaveTextContent("r/csMajors");
    expect(forums).toHaveTextContent("Hacker News");
    expect(forums).toHaveTextContent("People compare offer timelines.");
  });

  it("shows company news with what it is about, its source and date", async () => {
    await renderNews(newsDoc("2026-11-10"));
    const news = section("Company news");
    expect(within(news).getByRole("link", { name: "Acme raises a Series C" })).toHaveAttribute(
      "href",
      "https://techcrunch.com/2026/11/09/acme-series-c/",
    );
    expect(news).toHaveTextContent("Funding");
    expect(news).toHaveTextContent("TechCrunch");
    expect(news).toHaveTextContent("Nov 9");
  });

  it("gives every industry story a why-it-matters line and a source link", async () => {
    await renderNews(newsDoc("2026-11-10"));
    const stories = within(section("Industry news")).getAllByRole("listitem");
    expect(stories).toHaveLength(5);
    for (const story of stories) {
      expect(story).toHaveTextContent("Why it matters: Interviewers ask about it.");
      expect(within(story).getByRole("link")).toHaveAttribute(
        "href",
        expect.stringMatching(/^https:\/\/www\.reuters\.com\//),
      );
    }
    expect(stories[0]).toHaveTextContent("AI and LLMs");
    expect(stories[1]).toHaveTextContent("Big tech");
    expect(stories[2]).toHaveTextContent("Entry-level market");
  });

  it("opens source links in a new tab", async () => {
    await renderNews(newsDoc("2026-11-10"));
    const links = within(panel())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href") !== "#postings");
    expect(links).toHaveLength(9);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
  });

  it("says when a section has nothing today, and why when Refresh said so", async () => {
    await renderNews(
      newsDoc("2026-11-10", {
        hiringSignals: [],
        companyNews: [],
        forumHighlights: [],
        gaps: [{ section: "forumHighlights", note: "Reddit could not be reached today." }],
      }),
    );
    expect(section("Hiring signals")).toHaveTextContent(
      "No Fortune 500 or top-tier company opened entry-level Postings in your Job List this week.",
    );
    expect(section("Company news")).toHaveTextContent(
      "Nothing notable about the companies in your Queue today.",
    );
    expect(section("Forum highlights")).toHaveTextContent("Reddit could not be reached today.");
  });

  it("browses past days, newest to oldest", async () => {
    const user = userEvent.setup();
    await renderNews({
      ...newsDoc("2026-11-08", { newThisWeek: 8 }),
      ...newsDoc("2026-11-10"),
      ...newsDoc("2026-11-09", { newThisWeek: 9 }),
    });
    const newer = within(panel()).getByRole("button", { name: "Newer day" });
    const older = within(panel()).getByRole("button", { name: "Older day" });
    expect(newer).toBeDisabled();

    await user.click(older);
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Monday, November 9, 2026",
    );
    expect(panel()).toHaveTextContent("9 Postings in your Job List went up this week");

    await user.click(older);
    expect(older).toBeDisabled();
    await user.click(newer);
    await user.click(newer);
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Tuesday, November 10, 2026",
    );
  });

  it("jumps to any past day from the day list", async () => {
    const user = userEvent.setup();
    await renderNews({ ...newsDoc("2026-11-08", { newThisWeek: 8 }), ...newsDoc("2026-11-10") });
    const days = within(panel()).getByRole("combobox", { name: "Day" });
    expect(
      within(days)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Tue, Nov 10", "Sun, Nov 8"]);
    await user.selectOptions(days, "2026-11-08");
    expect(panel()).toHaveTextContent("8 Postings in your Job List went up this week");
  });

  it("shows when the digest was built", async () => {
    await renderNews(newsDoc("2026-11-10"));
    expect(panel()).toHaveTextContent(/Built Nov 10, \d{1,2}:30 [AP]M/);
  });

  it("stays on the day being read when a new digest arrives", async () => {
    const user = userEvent.setup();
    const db = await renderNews({ ...newsDoc("2026-11-09"), ...newsDoc("2026-11-10") });
    await user.click(within(panel()).getByRole("button", { name: "Older day" }));
    await act(async () => {
      await db.doc("news/2026-11-11").set(newsDoc("2026-11-11")["news/2026-11-11"] as never);
    });
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Monday, November 9, 2026",
    );
  });

  it("leaves out a digest that does not match the contract", async () => {
    await renderNews({
      ...newsDoc("2026-11-09"),
      "news/2026-11-10": { schemaVersion: 1, day: "2026-11-10" },
    });
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Monday, November 9, 2026",
    );
  });

  it("says so when no digest can be read", async () => {
    await renderNews({ "news/2026-11-10": { schemaVersion: 1 } });
    expect(within(panel()).getByRole("alert")).toHaveTextContent(
      "Your News Digest doesn't match what this dashboard expects. Ask your Claude to refresh again to rebuild it.",
    );
  });

  it("says so when the digests alone stop loading", () => {
    render(<NewsTab state={{ kind: "failed" }} now={NOW} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your News Digest stopped loading. Reload the page to try again.",
    );
  });

  it("invites a Refresh before the first digest", async () => {
    await renderNews();
    expect(panel()).toHaveTextContent("No News Digest yet");
  });
});
