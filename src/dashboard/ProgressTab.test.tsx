// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
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
import {
  createMemoryDb,
  type MemoryDb,
  type MemoryDbOptions,
  type MemoryWrite,
} from "./testing/memory-db.ts";

const acme = posting({ company: "Acme", title: "Software Engineer, New Grad", score: 90 });
const brainy = posting({ company: "Brainy", title: "Machine Learning Engineer Intern", score: 70 });
const charlie = posting({ company: "Charlie", title: "Backend Engineer" });
const delta = posting({ company: "Delta", title: "Platform Engineer" });
const echo = posting({ company: "Echo", title: "Data Engineer" });
const foxtrot = posting({ company: "Foxtrot", title: "Frontend Engineer" });
const golf = posting({ company: "Golf", title: "Mobile Engineer" });
const NOW_ISO = new Date(NOW).toISOString();

const COLUMNS = [
  "Queued",
  "Ready for Review",
  "Submitted",
  "Interviewing",
  "Offer",
  "Closed",
] as const;
type Column = (typeof COLUMNS)[number];

beforeEach(() => {
  window.location.hash = "#progress";
});

afterEach(() => {
  cleanup();
});

const settle = () => act(() => Promise.resolve());

async function renderBoard(docs: Record<string, object> = {}, options?: MemoryDbOptions) {
  const db = createMemoryDb({ "settings/main": settings, ...docs }, options);
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("region", { name: "Progress board" });
  await settle();
  return db;
}

const column = (name: Column) => screen.getByRole("region", { name });
const countOf = (name: Column) => column(name).querySelector(".board-count")?.textContent;
const cardsIn = (name: Column) =>
  within(column(name))
    .queryAllByRole("listitem")
    .map((card) => card.querySelector(".board-card-company")?.textContent);
const cardOf = (company: string) => {
  const card = screen
    .getAllByRole("listitem")
    .find((item) => item.querySelector(".board-card-company")?.textContent === company);
  if (!card) throw new Error(`no card for ${company}`);
  return card;
};

/** Drags a card onto a column the way a mouse does: pick up, pass over, drop. */
function drag(company: string, to: Column) {
  const card = cardOf(company);
  fireEvent.dragStart(card);
  fireEvent.dragEnter(column(to));
  fireEvent.dragOver(column(to));
  fireEvent.drop(column(to));
  fireEvent.dragEnd(card);
}

const cardWrites = (db: MemoryDb): MemoryWrite[] =>
  db.writes.filter((write) => write.path.startsWith("cards/"));
/** The body of a set or update write. */
const dataOf = (write: MemoryWrite | undefined) =>
  write && write.op !== "delete" ? write.data : undefined;

describe("the Progress board", () => {
  it("shows six columns in Stage order, each with its count", async () => {
    await renderBoard({
      ...cardDoc(acme),
      ...cardDoc(brainy),
      ...cardDoc(charlie, { stage: "ready_for_review" }),
      ...cardDoc(delta, { stage: "submitted" }),
      ...cardDoc(echo, { stage: "interviewing" }),
      ...cardDoc(foxtrot, { stage: "offer" }),
      ...cardDoc(golf, { stage: "closed", closedReason: "rejected" }),
    });
    const board = screen.getByRole("region", { name: "Progress board" });
    const headings = within(board)
      .getAllByRole("heading")
      .map((h) => h.querySelector(".board-column-name")?.textContent);
    expect(headings).toEqual([...COLUMNS]);
    expect(COLUMNS.map(countOf)).toEqual(["2", "1", "1", "1", "1", "1"]);
    expect(cardsIn("Queued")).toEqual(["Acme", "Brainy"]);
    expect(cardsIn("Ready for Review")).toEqual(["Charlie"]);
    expect(cardsIn("Submitted")).toEqual(["Delta"]);
    expect(cardsIn("Interviewing")).toEqual(["Echo"]);
    expect(cardsIn("Offer")).toEqual(["Foxtrot"]);
    expect(cardsIn("Closed")).toEqual(["Golf"]);
  });

  it("gives every queued Posting a card, but leaves skipped Postings off the board", async () => {
    await renderBoard({
      ...jobListDocs([acme, brainy, charlie]),
      ...cardDoc(acme),
      ...skipDoc(brainy),
    });
    expect(cardsIn("Queued")).toEqual(["Acme"]);
    expect(screen.queryByText("Brainy")).not.toBeInTheDocument();
    expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
  });

  it("lists the Queue in Queue order and later Stages with the latest move first", async () => {
    await renderBoard({
      ...cardDoc(brainy),
      ...cardDoc(acme),
      ...cardDoc(charlie, { queuedAt: daysAgo(2) }),
      ...cardDoc(delta, { stage: "submitted", stageChangedAt: daysAgo(3) }),
      ...cardDoc(echo, { stage: "submitted", stageChangedAt: daysAgo(1) }),
      ...cardDoc(foxtrot, { stage: "submitted" }),
    });
    expect(cardsIn("Queued")).toEqual(["Charlie", "Acme", "Brainy"]);
    // Foxtrot never moved, so it has been Submitted since it was queued, today.
    expect(cardsIn("Submitted")).toEqual(["Foxtrot", "Echo", "Delta"]);
  });

  it("shows each card's title, how long it has been queued, and why a Closed card closed", async () => {
    await renderBoard({
      ...cardDoc(acme, { queuedAt: daysAgo(6) }),
      ...cardDoc(brainy, { queuedAt: daysAgo(2) }),
      ...cardDoc(charlie, { stage: "closed", closedReason: "rejected" }),
      ...cardDoc(delta, { stage: "closed", closedReason: "withdrawn" }),
    });
    expect(within(cardOf("Acme")).getByText("Software Engineer, New Grad")).toBeInTheDocument();
    expect(within(cardOf("Acme")).getByText("6 days in Queue")).toBeInTheDocument();
    expect(within(cardOf("Acme")).getByText("Possibly closed")).toBeInTheDocument();
    expect(within(cardOf("Brainy")).getByText("2 days in Queue")).toBeInTheDocument();
    expect(within(cardOf("Brainy")).queryByText("Possibly closed")).not.toBeInTheDocument();
    expect(within(cardOf("Charlie")).getByText("Rejected")).toBeInTheDocument();
    expect(within(cardOf("Delta")).getByText("Withdrew")).toBeInTheDocument();
  });

  it("shows an empty board with every column at zero before anything is queued", async () => {
    await renderBoard();
    expect(COLUMNS.map(countOf)).toEqual(["0", "0", "0", "0", "0", "0"]);
    expect(screen.getByText(/Postings you queue appear here/)).toBeInTheDocument();
  });

  it("leaves out a card that breaks the contract", async () => {
    const broken = cardDoc(brainy, { stage: "closed" }); // no closedReason
    await renderBoard({ ...cardDoc(acme), ...broken });
    expect(COLUMNS.map(countOf)).toEqual(["1", "0", "0", "0", "0", "0"]);
  });

  it("says so when the board can't load", async () => {
    const db = createMemoryDb({}, { failWith: { code: "unavailable", message: "offline" } });
    render(<App db={db} pageVersion="1.2.3" now={NOW} />);
    expect(
      await screen.findByText("Your board stopped loading. Reload the page to try again."),
    ).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("region", { name: "Progress board" })).not.toBeInTheDocument();
  });
});

describe("the filling marker", () => {
  it("shows a spinner on the one Queued card being filled", async () => {
    await renderBoard({
      ...cardDoc(acme, { fillingSince: NOW_ISO }),
      ...cardDoc(brainy),
    });
    const filling = cardOf("Acme");
    expect(within(filling).getByText("Filling")).toBeInTheDocument();
    expect(filling.querySelector(".spinner")).not.toBeNull();
    expect(filling).toHaveAttribute("aria-busy", "true");
    expect(cardOf("Brainy").querySelector(".spinner")).toBeNull();
    expect(cardOf("Brainy")).not.toHaveAttribute("aria-busy");
    // Filling is not a Stage: the card stays in the Queued column.
    expect(cardsIn("Queued")).toEqual(["Acme", "Brainy"]);
  });
});

describe("dragging a card", () => {
  it("moves the card to the column it is dropped on and saves its new Stage", async () => {
    const db = await renderBoard({ ...cardDoc(acme, { stage: "ready_for_review" }) });
    drag("Acme", "Submitted");
    await settle();
    expect(cardWrites(db)).toEqual([
      {
        op: "set",
        path: `cards/${acme.id}`,
        data: {
          schemaVersion: 1,
          postingId: acme.id,
          stage: "submitted",
          queuedAt: REFRESHED,
          queuedBy: "refresh",
          stageChangedAt: NOW_ISO,
          posting: acme,
          updatedAt: NOW_ISO,
        },
      },
    ]);
    expect(cardsIn("Ready for Review")).toEqual([]);
    expect(cardsIn("Submitted")).toEqual(["Acme"]);
    expect([countOf("Ready for Review"), countOf("Submitted")]).toEqual(["0", "1"]);
  });

  it("highlights the column under the dragged card", async () => {
    await renderBoard({ ...cardDoc(acme) });
    const card = cardOf("Acme");
    fireEvent.dragStart(card);
    expect(card).toHaveClass("board-card-dragging");
    fireEvent.dragEnter(column("Offer"));
    fireEvent.dragOver(column("Offer"));
    expect(column("Offer")).toHaveClass("board-column-target");
    fireEvent.dragLeave(column("Offer"));
    expect(column("Offer")).not.toHaveClass("board-column-target");
    fireEvent.dragEnd(card);
    expect(card).not.toHaveClass("board-card-dragging");
  });

  it("can drag a card back to undo a move", async () => {
    const db = await renderBoard({
      ...cardDoc(acme, { stage: "interviewing", stageChangedAt: daysAgo(1) }),
    });
    drag("Acme", "Queued");
    await settle();
    expect(cardWrites(db)).toHaveLength(1);
    expect(cardsIn("Queued")).toEqual(["Acme"]);
  });

  it("writes nothing when a card is dropped back on its own column", async () => {
    const db = await renderBoard({ ...cardDoc(acme) });
    drag("Acme", "Queued");
    await settle();
    expect(cardWrites(db)).toEqual([]);
  });

  it("clears the filling marker when a filling card is moved", async () => {
    const db = await renderBoard({ ...cardDoc(acme, { fillingSince: NOW_ISO }) });
    drag("Acme", "Ready for Review");
    await settle();
    const [write] = cardWrites(db);
    expect(write).toMatchObject({ op: "set", data: { stage: "ready_for_review" } });
    expect(dataOf(write)).not.toHaveProperty("fillingSince");
    expect(cardOf("Acme").querySelector(".spinner")).toBeNull();
  });

  it("says so, and leaves the card where it was, when the move can't be saved", async () => {
    await renderBoard(
      { ...cardDoc(acme) },
      { failWritesWith: { code: "quota_exceeded", message: "full" } },
    );
    drag("Acme", "Submitted");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your dashboard storage is full, so that change wasn't saved.",
    );
    expect(cardsIn("Queued")).toEqual(["Acme"]);
  });
});

describe("moving a card to Closed", () => {
  it("asks whether the Candidate was rejected or withdrew, and saves the answer", async () => {
    const user = userEvent.setup();
    const db = await renderBoard({ ...cardDoc(acme, { stage: "submitted" }) });
    drag("Acme", "Closed");
    const prompt = await screen.findByRole("dialog", { name: "Why did Acme close?" });
    expect(cardWrites(db)).toEqual([]);
    await user.click(within(prompt).getByRole("button", { name: "Rejected" }));
    await settle();
    expect(cardWrites(db)).toEqual([
      {
        op: "set",
        path: `cards/${acme.id}`,
        data: expect.objectContaining({
          stage: "closed",
          closedReason: "rejected",
          stageChangedAt: NOW_ISO,
        }) as unknown,
      },
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cardsIn("Closed")).toEqual(["Acme"]);
    expect(within(cardOf("Acme")).getByText("Rejected")).toBeInTheDocument();
  });

  it("records a withdrawal", async () => {
    const user = userEvent.setup();
    const db = await renderBoard({ ...cardDoc(acme, { stage: "interviewing" }) });
    drag("Acme", "Closed");
    await user.click(await screen.findByRole("button", { name: "I withdrew" }));
    await settle();
    expect(cardWrites(db)[0]).toMatchObject({
      data: { stage: "closed", closedReason: "withdrawn" },
    });
  });

  it("leaves the card where it was when the Candidate cancels", async () => {
    const user = userEvent.setup();
    const db = await renderBoard({ ...cardDoc(acme, { stage: "submitted" }) });
    drag("Acme", "Closed");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await settle();
    expect(cardWrites(db)).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cardsIn("Submitted")).toEqual(["Acme"]);
  });

  it("drops the reason when a Closed card is dragged back out", async () => {
    const db = await renderBoard({
      ...cardDoc(acme, { stage: "closed", closedReason: "rejected" }),
    });
    drag("Acme", "Interviewing");
    await settle();
    const [write] = cardWrites(db);
    expect(write).toMatchObject({ data: { stage: "interviewing" } });
    expect(dataOf(write)).not.toHaveProperty("closedReason");
  });
});

describe("opening a card", () => {
  const openCard = async (company: string) => {
    const user = userEvent.setup();
    await user.click(within(cardOf(company)).getByRole("button"));
    return { user, drawer: await screen.findByRole("dialog") };
  };

  it("opens the same detail drawer as the Postings tab", async () => {
    await renderBoard({ ...cardDoc(acme, { stage: "submitted" }) });
    const { drawer } = await openCard("Acme");
    expect(drawer).toHaveAccessibleName("Software Engineer, New Grad");
    expect(drawer).toHaveClass("drawer");
    expect(within(drawer).getByRole("link", { name: /Open the Posting/ })).toHaveAttribute(
      "href",
      acme.applyUrl,
    );
    expect(within(drawer).getByRole("heading", { name: "Resume Variant" })).toBeInTheDocument();
    expect(within(drawer).getByRole("heading", { name: "Details" })).toBeInTheDocument();
  });

  it("shows the Posting as the Job List has it now, falling back to the card's snapshot", async () => {
    const renamed: Posting = { ...acme, title: "Software Engineer I, New Grad" };
    await renderBoard({ ...jobListDocs([renamed]), ...cardDoc(acme), ...cardDoc(brainy) });
    const first = await openCard("Acme");
    expect(first.drawer).toHaveAccessibleName("Software Engineer I, New Grad");
    await first.user.click(within(first.drawer).getByRole("button", { name: "Close" }));
    const second = await openCard("Brainy");
    expect(second.drawer).toHaveAccessibleName("Machine Learning Engineer Intern");
  });

  it("shows the card's Stage in the drawer and moves it from there", async () => {
    const db = await renderBoard({ ...cardDoc(acme, { stage: "submitted" }) });
    const { user, drawer } = await openCard("Acme");
    const stage = within(drawer).getByRole("combobox", { name: "Stage" });
    expect(stage).toHaveValue("submitted");
    await user.selectOptions(stage, "interviewing");
    await settle();
    expect(cardWrites(db)[0]).toMatchObject({ data: { stage: "interviewing" } });
    expect(cardsIn("Interviewing")).toEqual(["Acme"]);
    expect(within(drawer).getByRole("combobox", { name: "Stage" })).toHaveValue("interviewing");
  });

  it("asks for the reason when the drawer moves a card to Closed", async () => {
    const db = await renderBoard({ ...cardDoc(acme, { stage: "submitted" }) });
    const { user, drawer } = await openCard("Acme");
    await user.selectOptions(within(drawer).getByRole("combobox", { name: "Stage" }), "closed");
    const prompt = await screen.findByRole("dialog", { name: "Why did Acme close?" });
    await user.click(within(prompt).getByRole("button", { name: "I withdrew" }));
    await settle();
    expect(cardWrites(db)[0]).toMatchObject({
      data: { stage: "closed", closedReason: "withdrawn" },
    });
    expect(within(drawer).getByText("You withdrew.")).toBeInTheDocument();
  });

  it("says in the drawer when a card is being filled", async () => {
    await renderBoard({ ...cardDoc(acme, { fillingSince: NOW_ISO }) });
    const { drawer } = await openCard("Acme");
    expect(within(drawer).getByText(/Your Claude is filling this application now/)).toBeVisible();
  });
});
