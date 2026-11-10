// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings, VariantOverride } from "../contract/index.ts";
import { App } from "./App.tsx";
import { jobListDocs, posting } from "./testing/fixtures.ts";
import { createMemoryDb, type MemoryDbOptions } from "./testing/memory-db.ts";

const NOW = Date.parse("2026-11-10T15:00:00.000Z");

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "high" },
    ],
    seniority: ["intern", "new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City", "Remote"] }, { locations: ["Boston"] }],
  },
  resumeVariants: [
    { name: "Generalist SWE", roleTypes: ["Software Engineer"], keywords: [] },
    { name: "Backend SWE/SDE", roleTypes: [], keywords: ["backend"] },
    { name: "AI/ML Engineer", roleTypes: ["Machine Learning Engineer"], keywords: ["ML"] },
  ],
  dailyQueueTarget: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const acme = posting({
  company: "Acme",
  title: "Backend Engineer, New Grad",
  applyUrl: "https://job-boards.greenhouse.io/acme/jobs/42",
  locations: ["New York, NY", "Boston, MA", "Austin, TX"],
  locationTier: 1,
  score: 91,
  boosts: ["Fortune 500"],
  postedOn: "2026-11-08",
  sources: [
    { name: "Job Feed", list: "Simplify New Grad" },
    { name: "Job Feed", list: "Vansh New Grad" },
  ],
  resumeVariant: {
    name: "Backend SWE/SDE",
    reason: 'The title mentions "backend".',
  },
});
const brainy = posting({
  company: "Brainy",
  title: "Machine Learning Engineer Intern",
  roleType: "Machine Learning Engineer",
  level: "intern",
  locationTier: 2,
  locations: ["Boston, MA"],
  sources: [{ name: "Watchlist" }],
  description: "Train ranking models for search. You will work in Python and PyTorch.",
  resumeVariant: {
    name: "AI/ML Engineer",
    reason: "Made for Machine Learning Engineer roles.",
  },
});

beforeEach(() => {
  window.location.hash = "#postings";
});

afterEach(() => {
  cleanup();
});

async function renderPostings(extra: Record<string, object> = {}, options: MemoryDbOptions = {}) {
  const db = createMemoryDb(
    { "settings/main": settings, ...jobListDocs([acme, brainy]), ...extra },
    options,
  );
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("list", { name: "Job List" });
  await act(() => Promise.resolve());
  return db;
}

const row = (company: string) => {
  const found = screen
    .getAllByRole("listitem")
    .find((item) => item.querySelector(".posting-company")?.textContent === company);
  if (!found) throw new Error(`no row for ${company}`);
  return found;
};

async function open(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: title }));
  return screen.getByRole("dialog", { name: title });
}

const override = (variant: string): VariantOverride => ({
  schemaVersion: 1,
  variant,
  chosenAt: "2026-11-09T12:00:00.000Z",
});

describe("detail drawer", () => {
  it("opens from a Posting with its details, Resume Variant and reason", async () => {
    const user = userEvent.setup();
    await renderPostings();
    const drawer = await open(user, "Backend Engineer, New Grad");
    expect(drawer).toHaveTextContent("Acme");
    expect(drawer).toHaveTextContent("New York, NY; Boston, MA; Austin, TX");
    expect(drawer).toHaveTextContent("Location TierTier 1");
    expect(drawer).toHaveTextContent("Score91 out of 100");
    expect(drawer).toHaveTextContent("Fortune 500");
    expect(drawer).toHaveTextContent("Role typeSoftware Engineer");
    expect(drawer).toHaveTextContent("SeniorityNew grad");
    expect(drawer).toHaveTextContent("Posted2 days ago");
    expect(drawer).toHaveTextContent("SourceJob Feed: Simplify New Grad, Vansh New Grad");
    expect(within(drawer).getByRole("combobox", { name: "Resume Variant" })).toHaveValue(
      "Backend SWE/SDE",
    );
    expect(within(drawer).getByText('The title mentions "backend".')).toBeInTheDocument();
    const apply = within(drawer).getByRole("link", { name: /Open the Posting/ });
    expect(apply).toHaveAttribute("href", "https://job-boards.greenhouse.io/acme/jobs/42");
    expect(apply).toHaveAttribute("target", "_blank");
    expect(apply).toHaveTextContent("job-boards.greenhouse.io");
  });

  it("explains that the Job Feed gives no description", async () => {
    const user = userEvent.setup();
    await renderPostings();
    const drawer = await open(user, "Backend Engineer, New Grad");
    expect(drawer).toHaveTextContent(
      "The Job Feed doesn't include descriptions. Open the Posting to read the full description.",
    );
  });

  it("shows a description excerpt when the Source gives one", async () => {
    const user = userEvent.setup();
    await renderPostings();
    const drawer = await open(user, "Machine Learning Engineer Intern");
    expect(drawer).toHaveTextContent("Train ranking models for search.");
    expect(drawer).toHaveTextContent("SourceWatchlist");
    expect(drawer).toHaveTextContent("Location TierTier 2");
  });

  it("closes with the close button or Escape and returns focus to the Posting", async () => {
    const user = userEvent.setup();
    await renderPostings();
    await open(user, "Backend Engineer, New Grad");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backend Engineer, New Grad" })).toHaveFocus();

    await open(user, "Machine Learning Engineer Intern");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Machine Learning Engineer Intern" })).toHaveFocus();
  });

  it("moves focus into the drawer when it opens", async () => {
    const user = userEvent.setup();
    await renderPostings();
    const drawer = await open(user, "Backend Engineer, New Grad");
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
  });

  it("saves the Candidate's choice of Resume Variant to the database", async () => {
    const user = userEvent.setup();
    const db = await renderPostings();
    const drawer = await open(user, "Backend Engineer, New Grad");
    await user.selectOptions(
      within(drawer).getByRole("combobox", { name: "Resume Variant" }),
      "Generalist SWE",
    );
    expect(db.writes).toEqual([
      {
        op: "set",
        path: `variantOverrides/${acme.id}`,
        data: { schemaVersion: 1, variant: "Generalist SWE", chosenAt: "2026-11-10T15:00:00.000Z" },
      },
    ]);
    expect(await within(drawer).findByText("Saved")).toHaveAttribute("role", "status");
    expect(drawer).toHaveTextContent("You chose this Resume Variant.");
    expect(drawer).toHaveTextContent(
      'Refresh picked Backend SWE/SDE. The title mentions "backend".',
    );
    expect(row("Acme")).toHaveTextContent("Resume: Generalist SWE (your choice)");
  });

  it("goes back to Refresh's pick by deleting the Candidate's choice", async () => {
    const user = userEvent.setup();
    const db = await renderPostings({
      [`variantOverrides/${acme.id}`]: override("AI/ML Engineer"),
    });
    const drawer = await open(user, "Backend Engineer, New Grad");
    const select = within(drawer).getByRole("combobox", { name: "Resume Variant" });
    expect(select).toHaveValue("AI/ML Engineer");
    await user.selectOptions(select, "Backend SWE/SDE");
    expect(db.writes).toEqual([{ op: "delete", path: `variantOverrides/${acme.id}` }]);
    expect(await within(drawer).findByText('The title mentions "backend".')).toBeInTheDocument();
    expect(row("Acme")).toHaveTextContent("Resume: Backend SWE/SDE");
    expect(row("Acme")).not.toHaveTextContent("your choice");
  });

  it("marks Refresh's pick among the choices", async () => {
    const user = userEvent.setup();
    await renderPostings();
    const drawer = await open(user, "Backend Engineer, New Grad");
    const options = within(drawer)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Generalist SWE",
      "Backend SWE/SDE (Refresh's pick)",
      "AI/ML Engineer",
    ]);
  });

  it("shows a choice saved earlier and ignores one for a Resume Variant that is gone", async () => {
    await renderPostings({
      [`variantOverrides/${acme.id}`]: override("AI/ML Engineer"),
      [`variantOverrides/${brainy.id}`]: override("Retired variant"),
    });
    expect(row("Acme")).toHaveTextContent("Resume: AI/ML Engineer (your choice)");
    expect(row("Brainy")).toHaveTextContent("Resume: AI/ML Engineer");
    expect(row("Brainy")).not.toHaveTextContent("your choice");
  });

  it("says so and keeps the earlier choice when saving fails", async () => {
    const user = userEvent.setup();
    await renderPostings(
      {},
      { failWritesWith: { code: "quota_exceeded", message: "The database is full." } },
    );
    const drawer = await open(user, "Backend Engineer, New Grad");
    const select = within(drawer).getByRole("combobox", { name: "Resume Variant" });
    await user.selectOptions(select, "Generalist SWE");
    expect(await within(drawer).findByRole("alert")).toHaveTextContent(
      "Your choice wasn't saved: your dashboard storage is full.",
    );
    expect(select).toHaveValue("Backend SWE/SDE");
  });

  it("closes when the Posting leaves the Job List", async () => {
    const user = userEvent.setup();
    const db = await renderPostings();
    await open(user, "Machine Learning Engineer Intern");
    await act(async () => {
      for (const [path, data] of Object.entries(
        jobListDocs([acme], {}, "2026-11-11T14:30:00.000Z"),
      )) {
        await db.doc(path).set(data as Record<string, unknown>);
      }
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
