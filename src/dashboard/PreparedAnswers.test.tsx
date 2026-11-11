// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreparedApplication } from "../contract/index.ts";
import { App } from "./App.tsx";
import { NOW, REFRESHED, cardDoc, jobListDocs, posting, settings } from "./testing/fixtures.ts";
import { createMemoryDb, type MemoryDbOptions } from "./testing/memory-db.ts";

const figma = posting({ company: "Figma", title: "Software Engineer, New Grad" });
const stripe = posting({ company: "Stripe", title: "Software Engineer Intern", level: "intern" });

const AT = new Date(NOW).toISOString();

const application: PreparedApplication = {
  schemaVersion: 1,
  postingId: figma.id,
  preparedAt: REFRESHED,
  preparedBy: "refresh",
  questions: [
    {
      question: "Why do you want to join Figma?",
      type: "why_company",
      mode: "brief",
      draft: "I design every side project in Figma first, so I know where it shines.",
    },
    {
      question: "Tell us about a project you are proud of.",
      type: "project",
      mode: "ai",
      draft: "I built a course planner that 2,000 students at my school use each term.",
      maxLength: 500,
    },
  ],
  brief: {
    company: "Figma makes a collaborative design tool used by product teams.",
    news: [
      {
        headline: "Figma ships a new AI design feature",
        url: "https://www.theverge.com/figma-ai",
        source: "The Verge",
        publishedOn: "2026-11-01",
      },
    ],
    team: "The role sits on the Editor team, which builds the canvas.",
    fit: "Your course planner and TypeScript internship match the frontend focus.",
  },
  updatedAt: REFRESHED,
};

beforeEach(() => {
  window.location.hash = "#progress";
});

afterEach(() => {
  cleanup();
});

async function renderBoard(extra: Record<string, object> = {}, options: MemoryDbOptions = {}) {
  const db = createMemoryDb(
    {
      "settings/main": settings,
      ...jobListDocs([figma, stripe]),
      ...cardDoc(figma),
      ...cardDoc(stripe),
      [`applications/${figma.id}`]: application,
      ...extra,
    },
    options,
  );
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("region", { name: "Progress board" });
  await act(() => Promise.resolve());
  return db;
}

async function openCard(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(title) }));
  return screen.getByRole("dialog", { name: title });
}

function answer(drawer: HTMLElement, question: string) {
  return within(drawer).getByRole("article", { name: question });
}

describe("Prepared Application answers in the drawer", () => {
  it("shows each answer, marking the AI-drafted ones, with the Research Brief", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const drawer = await openCard(user, "Software Engineer, New Grad");

    within(drawer).getByRole("heading", { name: "Answers" });
    const project = answer(drawer, "Tell us about a project you are proud of.");
    within(project).getByText("AI-drafted");
    expect(within(project).getByRole("textbox", { name: "AI-drafted answer" })).toHaveValue(
      application.questions[1]?.draft,
    );
    within(project).getByText("72 of 500 characters");
    expect(within(project).getByRole("button", { name: "AI draft" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const why = answer(drawer, "Why do you want to join Figma?");
    expect(within(why).queryByText("AI-drafted")).toBeNull();
    expect(within(why).getByRole("button", { name: "My own words" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The AI draft is kept but never shown as the answer in brief mode.
    expect(within(why).getByRole("textbox", { name: "Your answer" })).toHaveValue("");
    within(why).getByText("Until you write it, Fill leaves this question blank and flags it.");

    const brief = within(drawer).getByRole("region", { name: "Research Brief" });
    within(brief).getByText(application.brief?.company ?? "");
    within(brief).getByText(application.brief?.team ?? "");
    within(brief).getByText(application.brief?.fit ?? "");
    expect(
      within(brief).getByRole("link", { name: /Figma ships a new AI design feature/ }),
    ).toHaveAttribute("href", "https://www.theverge.com/figma-ai");
    within(brief).getByText("The Verge, Nov 1");
    expect(
      within(brief).getByRole("link", { name: /Find Figma recruiters on LinkedIn/ }),
    ).toHaveAttribute(
      "href",
      "https://www.linkedin.com/search/results/people/?keywords=Figma%20recruiter",
    );
  });

  it("saves the Candidate's edit of an AI-drafted answer, then marks it edited", async () => {
    const user = userEvent.setup();
    const db = await renderBoard();
    const drawer = await openCard(user, "Software Engineer, New Grad");
    const project = answer(drawer, "Tell us about a project you are proud of.");
    const box = within(project).getByRole("textbox", { name: "AI-drafted answer" });

    expect(within(project).queryByRole("button", { name: "Save answer" })).toBeNull();
    await user.clear(box);
    await user.type(box, "My course planner serves 2,000 students.");
    await user.click(within(project).getByRole("button", { name: "Save answer" }));

    expect(db.writes.at(-1)).toEqual({
      op: "set",
      path: `applications/${figma.id}`,
      data: {
        ...application,
        questions: [
          application.questions[0],
          {
            ...application.questions[1],
            draft: "My course planner serves 2,000 students.",
            editedAt: AT,
          },
        ],
        updatedAt: AT,
      },
    });
    await within(project).findByText("AI-drafted, edited by you");
    within(project).getByText("Saved");
    expect(within(project).queryByRole("button", { name: "Save answer" })).toBeNull();
  });

  it("discards an unsaved edit", async () => {
    const user = userEvent.setup();
    const db = await renderBoard();
    const drawer = await openCard(user, "Software Engineer, New Grad");
    const project = answer(drawer, "Tell us about a project you are proud of.");
    const box = within(project).getByRole("textbox", { name: "AI-drafted answer" });
    await user.type(box, " More.");
    await user.click(within(project).getByRole("button", { name: "Discard" }));
    expect(box).toHaveValue(application.questions[1]?.draft);
    expect(db.writes).toEqual([]);
  });

  it("switches one answer's mode with one click, keeping both texts", async () => {
    const user = userEvent.setup();
    const db = await renderBoard();
    const drawer = await openCard(user, "Software Engineer, New Grad");
    const why = answer(drawer, "Why do you want to join Figma?");

    await user.click(within(why).getByRole("button", { name: "AI draft" }));
    expect(db.writes).toHaveLength(1);
    expect(db.contents()[`applications/${figma.id}`]?.questions).toEqual([
      { ...application.questions[0], mode: "ai" },
      application.questions[1],
    ]);
    expect(await within(why).findByRole("textbox", { name: "AI-drafted answer" })).toHaveValue(
      application.questions[0]?.draft,
    );
    within(why).getByText("AI-drafted");

    await user.click(within(why).getByRole("button", { name: "My own words" }));
    expect(db.contents()[`applications/${figma.id}`]?.questions).toEqual(application.questions);
    await within(why).findByRole("textbox", { name: "Your answer" });
  });

  it("saves what the Candidate writes under the brief", async () => {
    const user = userEvent.setup();
    const db = await renderBoard();
    const drawer = await openCard(user, "Software Engineer, New Grad");
    const why = answer(drawer, "Why do you want to join Figma?");

    await user.type(
      within(why).getByRole("textbox", { name: "Your answer" }),
      "I sketch every idea in Figma before I write code.",
    );
    await user.click(within(why).getByRole("button", { name: "Save answer" }));
    expect(db.contents()[`applications/${figma.id}`]?.questions).toEqual([
      { ...application.questions[0], own: "I sketch every idea in Figma before I write code." },
      application.questions[1],
    ]);
    await within(why).findByText("Saved");
    expect(
      within(why).queryByText("Until you write it, Fill leaves this question blank and flags it."),
    ).toBeNull();
  });

  it("keeps an AI-mode answer from being saved empty or over the form's limit", async () => {
    const user = userEvent.setup();
    const db = await renderBoard();
    const drawer = await openCard(user, "Software Engineer, New Grad");
    const project = answer(drawer, "Tell us about a project you are proud of.");
    const box = within(project).getByRole("textbox", { name: "AI-drafted answer" });

    await user.clear(box);
    expect(within(project).getByRole("button", { name: "Save answer" })).toBeDisabled();
    within(project).getByText(
      "An AI-drafted answer can't be empty. Switch to My own words to leave it for yourself.",
    );
    expect(box).toHaveAttribute("maxlength", "500");
    expect(db.writes).toEqual([]);
  });

  it("says why an answer was not saved", async () => {
    const user = userEvent.setup();
    await renderBoard({}, { failWritesWith: { code: "quota_exceeded", message: "full" } });
    const drawer = await openCard(user, "Software Engineer, New Grad");
    const why = answer(drawer, "Why do you want to join Figma?");
    await user.click(within(why).getByRole("button", { name: "AI draft" }));
    expect(await within(why).findByRole("alert")).toHaveTextContent(
      "Your dashboard storage is full, so this change wasn't saved. To make room, ask your Claude to run /job-app-assist:tidy.",
    );
    expect(within(why).getByRole("button", { name: "My own words" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("says when a queued card has no Prepared Application yet", async () => {
    const user = userEvent.setup();
    await renderBoard();
    const drawer = await openCard(user, "Software Engineer Intern");
    const section = within(drawer).getByRole("region", { name: "Answers" });
    within(section).getByText(
      "No answers yet. Your Claude prepares them on the next Refresh, or when it fills this Posting.",
    );
    expect(within(drawer).queryByRole("region", { name: "Research Brief" })).toBeNull();
  });

  it("says when the form has no free-text questions", async () => {
    const user = userEvent.setup();
    await renderBoard({
      [`applications/${stripe.id}`]: {
        schemaVersion: 1,
        postingId: stripe.id,
        preparedAt: REFRESHED,
        preparedBy: "refresh",
        questions: [],
        updatedAt: REFRESHED,
      },
    });
    const drawer = await openCard(user, "Software Engineer Intern");
    within(drawer).getByText("This form has no free-text questions, so there is nothing to write.");
  });

  it("shows the same answers in the Postings tab's drawer for a queued Posting", async () => {
    window.location.hash = "#postings";
    const user = userEvent.setup();
    const db = createMemoryDb({
      "settings/main": settings,
      ...jobListDocs([figma, stripe]),
      ...cardDoc(figma),
      [`applications/${figma.id}`]: application,
    });
    render(<App db={db} pageVersion="1.2.3" now={NOW} />);
    await screen.findByRole("list", { name: "Job List" });
    await act(() => Promise.resolve());

    await user.click(screen.getByRole("button", { name: "Software Engineer, New Grad" }));
    const drawer = screen.getByRole("dialog", { name: "Software Engineer, New Grad" });
    answer(drawer, "Why do you want to join Figma?");
    await user.click(within(drawer).getByRole("button", { name: "Close" }));

    // A Posting that was never queued has no answers section.
    await user.click(screen.getByRole("button", { name: "Software Engineer Intern" }));
    const other = screen.getByRole("dialog", { name: "Software Engineer Intern" });
    expect(within(other).queryByRole("region", { name: "Answers" })).toBeNull();
  });
});
