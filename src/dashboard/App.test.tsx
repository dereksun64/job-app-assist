// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../contract/index.ts";
import { App, LOADING_TIMEOUT_MS } from "./App.tsx";
import { createMemoryDb } from "./testing/memory-db.ts";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "high" },
      { name: "Product Manager", priority: "low" },
    ],
    seniority: ["intern", "new_grad"],
    startWindow: { earliest: "2027-01", latest: "2027-12" },
    locationTiers: [{ locations: ["New York City", "Remote"] }, { locations: ["Boston"] }],
  },
  resumeVariants: [{ name: "Generalist SWE", roleTypes: [], keywords: [] }],
  dailyQueueTarget: 20,
  updatedAt: "2026-11-10T15:00:00.000Z",
};

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function renderReady(db = createMemoryDb({ "settings/main": settings })) {
  render(<App db={db} pageVersion="1.2.3" />);
  await screen.findByRole("tablist");
  await act(() => Promise.resolve());
  return db;
}

describe("dashboard tabs", () => {
  it("shows News, Postings and Progress tabs with News selected first", async () => {
    await renderReady();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["News", "Postings", "Progress"]);
    expect(screen.getByRole("tab", { name: "News" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "News" })).toBeVisible();
  });

  it("renders an empty state on every tab when the database holds only settings", async () => {
    const user = userEvent.setup();
    await renderReady();

    expect(screen.getByRole("tabpanel", { name: "News" })).toHaveTextContent("No News Digest yet");

    await user.click(screen.getByRole("tab", { name: "Postings" }));
    expect(screen.getByRole("tabpanel", { name: "Postings" })).toHaveTextContent(
      "Your Job List is empty",
    );

    await user.click(screen.getByRole("tab", { name: "Progress" }));
    const progress = screen.getByRole("tabpanel", { name: "Progress" });
    expect(progress).toHaveTextContent("Nothing in progress yet");
    expect(
      within(progress)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Queued", "Ready for Review", "Submitted", "Interviewing", "Offer", "Closed"]);
  });

  it("switches tabs and records the open tab in the address hash", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByRole("tab", { name: "Progress" }));
    expect(screen.getByRole("tab", { name: "Progress" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "News" })).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("tabpanel", { name: "News" })).toBeNull();
    expect(window.location.hash).toBe("#progress");
  });

  it("opens the tab named in the address hash", async () => {
    window.location.hash = "#postings";
    await renderReady();
    expect(screen.getByRole("tab", { name: "Postings" })).toHaveAttribute("aria-selected", "true");
  });

  it("follows the address hash when it changes", async () => {
    await renderReady();
    await act(() => {
      window.location.hash = "#progress";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByRole("tab", { name: "Progress" })).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to News for an unknown hash", async () => {
    window.location.hash = "#settings";
    await renderReady();
    expect(screen.getByRole("tab", { name: "News" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves between tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    await renderReady();
    screen.getByRole("tab", { name: "News" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Postings" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Postings" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Progress" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "News" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Progress" })).toHaveFocus();
  });
});

describe("Search Profile summary", () => {
  it("summarizes the saved Search Profile and daily Queue target", async () => {
    await renderReady();
    const summary = screen.getByRole("region", { name: "Search Profile" });
    expect(summary).toHaveTextContent(
      "High priority: Software Engineer, Machine Learning Engineer",
    );
    expect(summary).toHaveTextContent("Low priority: Product Manager");
    expect(summary).toHaveTextContent("Intern, New grad");
    expect(summary).toHaveTextContent("Jan 2027 to Dec 2027");
    expect(summary).toHaveTextContent("Tier 1: New York City, Remote");
    expect(summary).toHaveTextContent("Tier 2: Boston");
    expect(summary).toHaveTextContent("20 a day");
  });

  it("lists role types without priority labels when they share one priority", async () => {
    await renderReady(
      createMemoryDb({
        "settings/main": {
          ...settings,
          searchProfile: {
            ...settings.searchProfile,
            roleTypes: [
              { name: "Software Engineer", priority: "medium" },
              { name: "Data Engineer", priority: "medium" },
            ],
          },
        },
      }),
    );
    const summary = screen.getByRole("region", { name: "Search Profile" });
    expect(summary).toHaveTextContent("Software Engineer, Data Engineer");
    expect(summary).not.toHaveTextContent("priority");
  });

  it("describes open-ended start windows", async () => {
    await renderReady(
      createMemoryDb({
        "settings/main": {
          ...settings,
          searchProfile: { ...settings.searchProfile, startWindow: { earliest: "2027-05" } },
        },
      }),
    );
    expect(screen.getByRole("region", { name: "Search Profile" })).toHaveTextContent(
      "From May 2027",
    );
  });

  it("updates live when the settings document changes", async () => {
    const db = await renderReady();
    await act(() => db.doc("settings/main").set({ ...settings, dailyQueueTarget: 8 }));
    expect(screen.getByRole("region", { name: "Search Profile" })).toHaveTextContent("8 a day");
  });

  it("asks the Candidate to finish Setup when there is no settings document", async () => {
    await renderReady(createMemoryDb());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Setup isn't finished. Ask your Claude to run /job-app-assist:setup",
    );
    expect(screen.queryByRole("region", { name: "Search Profile" })).toBeNull();
    expect(screen.getByRole("tab", { name: "News" })).toBeInTheDocument();
  });

  it("explains a settings document that breaks the contract", async () => {
    await renderReady(createMemoryDb({ "settings/main": { ...settings, dailyQueueTarget: 0 } }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Your settings don't match what this dashboard expects");
    expect(alert).toHaveTextContent("dailyQueueTarget: must be at least 1");
    expect(alert).toHaveTextContent("/job-app-assist:setup");
  });

  it("writes nothing to the database", async () => {
    const db = await renderReady();
    expect(db.writes).toEqual([]);
  });
});

describe("database availability", () => {
  it("shows the tabs while it connects to the database", () => {
    render(<App db={undefined} pageVersion="1.2.3" />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading your dashboard");
  });

  it("explains when the database is not available in this view", async () => {
    render(<App db={null} pageVersion="1.2.3" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your dashboard data isn't available here. Open this page in claude.ai while signed in to the account that ran Setup.",
    );
  });

  it("says so when the database takes too long to answer", async () => {
    vi.useFakeTimers();
    const db = createMemoryDb({ "settings/main": settings }, { silent: true });
    render(<App db={db} pageVersion="1.2.3" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your dashboard");
    await act(() => {
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your dashboard data can't be reached yet. It will appear here as soon as it loads.",
    );
  });

  it("reports a failed subscription", async () => {
    const db = createMemoryDb(
      {},
      { failWith: { code: "revoked", message: "access was withdrawn" } },
    );
    render(<App db={db} pageVersion="1.2.3" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your dashboard data stopped loading. Reload the page to try again.",
    );
  });
});

describe("page version", () => {
  it("shows the Toolkit page version in the footer", async () => {
    await renderReady();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Toolkit page 1.2.3");
  });
});
