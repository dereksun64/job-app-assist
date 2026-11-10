// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Referrals } from "../contract/index.ts";
import { App } from "./App.tsx";
import { NOW, cardDoc, jobListDocs, posting, settings } from "./testing/fixtures.ts";
import { createMemoryDb } from "./testing/memory-db.ts";

const datadog = posting({ company: "Datadog", title: "Software Engineer, New Grad" });
const stripe = posting({ company: "Stripe", title: "Software Engineer Intern", level: "intern" });

const priyaMessage =
  "Hi Priya, I hope you're doing well! I'm applying to Datadog's new grad Software Engineer role and would love your take on the team.\n\nWould you be open to referring me?";

const referrals = (of: typeof datadog, drafts: Referrals["drafts"]): Record<string, Referrals> => ({
  [`referrals/${of.id}`]: {
    schemaVersion: 1,
    postingId: of.id,
    drafts,
    updatedAt: "2026-11-10T14:30:00.000Z",
  },
});

const datadogDrafts = referrals(datadog, [
  {
    name: "Priya Shah",
    company: "Datadog",
    position: "Senior Software Engineer",
    message: priyaMessage,
  },
  { name: "Omar Diaz", company: "Datadog, Inc.", message: "Hi Omar, would you refer me?" },
]);

beforeEach(() => {
  window.location.hash = "#postings";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderPostings(extra: Record<string, object> = {}) {
  const db = createMemoryDb({
    "settings/main": settings,
    ...jobListDocs([datadog, stripe]),
    ...extra,
  });
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("list", { name: "Job List" });
  await act(() => Promise.resolve());
  return db;
}

async function open(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: title }));
  return screen.getByRole("dialog", { name: title });
}

describe("Referral Drafts in the detail drawer", () => {
  it("shows each draft with the connection's name, company and message", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...cardDoc(datadog), ...datadogDrafts });
    const drawer = await open(user, "Software Engineer, New Grad");
    const section = within(drawer).getByRole("region", { name: "Referral Drafts" });
    expect(section).toHaveTextContent(
      "Ask a connection at Datadog to refer you before you apply. Copy a draft and send it yourself.",
    );
    const drafts = within(section).getAllByRole("article");
    expect(drafts).toHaveLength(2);
    const [priya, omar] = drafts as [HTMLElement, HTMLElement];
    expect(within(priya).getByRole("heading", { name: "Priya Shah" })).toBeInTheDocument();
    expect(priya).toHaveTextContent("Senior Software Engineer at Datadog");
    expect(within(priya).getByText(/I'm applying to Datadog's new grad/).textContent).toBe(
      priyaMessage,
    );
    expect(omar).toHaveTextContent("Omar DiazDatadog, Inc.");
  });

  it("copies a draft's message for the Candidate to send themselves", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...cardDoc(datadog), ...datadogDrafts });
    const drawer = await open(user, "Software Engineer, New Grad");
    const priya = within(drawer).getAllByRole("article")[0] as HTMLElement;
    await user.click(within(priya).getByRole("button", { name: "Copy message to Priya Shah" }));
    expect(await navigator.clipboard.readText()).toBe(priyaMessage);
    expect(within(priya).getByRole("status")).toHaveTextContent("Copied");
  });

  it("asks the Candidate to copy by hand when the browser will not copy", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...cardDoc(datadog), ...datadogDrafts });
    const drawer = await open(user, "Software Engineer, New Grad");
    const priya = within(drawer).getAllByRole("article")[0] as HTMLElement;
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Not allowed"));
    await user.click(within(priya).getByRole("button", { name: "Copy message to Priya Shah" }));
    expect(await within(priya).findByText(/Couldn't copy/)).toHaveTextContent(
      "Couldn't copy. Select the message and copy it yourself.",
    );
    expect(within(priya).getByRole("button", { name: "Copy message to Priya Shah" })).toHaveFocus();
  });

  it("offers a LinkedIn search for the connection, never a way to message them from here", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...cardDoc(datadog), ...datadogDrafts });
    const drawer = await open(user, "Software Engineer, New Grad");
    const priya = within(drawer).getAllByRole("article")[0] as HTMLElement;
    const search = within(priya).getByRole("link", { name: /Find Priya Shah on LinkedIn/ });
    expect(search).toHaveAttribute(
      "href",
      "https://www.linkedin.com/search/results/people/?keywords=Priya%20Shah%20Datadog",
    );
    expect(search).toHaveAttribute("target", "_blank");
    expect(within(drawer).queryByRole("button", { name: /send/i })).not.toBeInTheDocument();
  });

  it("shows no Referral Drafts section for a Posting without drafts", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...cardDoc(stripe), ...datadogDrafts });
    const drawer = await open(user, "Software Engineer Intern");
    expect(
      within(drawer).queryByRole("region", { name: "Referral Drafts" }),
    ).not.toBeInTheDocument();
  });

  it("hides the drafts of a Posting the Candidate took out of the Queue", async () => {
    const user = userEvent.setup();
    await renderPostings({ ...datadogDrafts });
    const drawer = await open(user, "Software Engineer, New Grad");
    expect(
      within(drawer).queryByRole("region", { name: "Referral Drafts" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a referrals document outside the contract", async () => {
    const user = userEvent.setup();
    await renderPostings({
      ...cardDoc(datadog),
      [`referrals/${datadog.id}`]: { schemaVersion: 1, postingId: datadog.id, drafts: "Priya" },
    });
    const drawer = await open(user, "Software Engineer, New Grad");
    expect(
      within(drawer).queryByRole("region", { name: "Referral Drafts" }),
    ).not.toBeInTheDocument();
  });

  it("shows a card's drafts in the drawer the Progress board opens", async () => {
    window.location.hash = "#progress";
    const user = userEvent.setup();
    const db = createMemoryDb({
      "settings/main": settings,
      ...jobListDocs([datadog, stripe]),
      ...cardDoc(datadog, { stage: "submitted" }),
      ...datadogDrafts,
    });
    render(<App db={db} pageVersion="1.2.3" now={NOW} />);
    const card = (await screen.findAllByRole("listitem")).find(
      (item) => item.querySelector(".board-card-company")?.textContent === "Datadog",
    );
    if (!card) throw new Error("no Datadog card on the board");
    await user.click(within(card).getByRole("button"));
    const drawer = await screen.findByRole("dialog");
    const section = within(drawer).getByRole("region", { name: "Referral Drafts" });
    expect(within(section).getAllByRole("article")).toHaveLength(2);
  });
});
