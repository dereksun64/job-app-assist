import { describe, expect, it } from "vitest";
import { greenhouseJob, readFormQuestions } from "./greenhouse.ts";

const figmaJob = {
  id: 6178851004,
  title: "Data Engineer Intern (2027)",
  content:
    "&lt;p&gt;Figma is growing our team of passionate creatives &amp;amp; builders.&lt;/p&gt;&lt;h2&gt;What you'll do&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Build data pipelines&lt;/li&gt;&lt;/ul&gt;",
  questions: [
    { required: true, label: "First Name", fields: [{ name: "first_name", type: "input_text" }] },
    {
      required: true,
      label: "Resume/CV",
      fields: [
        { name: "resume", type: "input_file" },
        { name: "resume_text", type: "textarea" },
      ],
    },
    {
      required: false,
      label: "Cover Letter",
      fields: [
        { name: "cover_letter", type: "input_file" },
        { name: "cover_letter_text", type: "textarea" },
      ],
    },
    {
      required: true,
      label: "How did you connect with us?",
      fields: [{ name: "question_1", type: "multi_value_single_select" }],
    },
    {
      required: true,
      label: "Why do you want to join Figma?",
      fields: [{ name: "question_2", type: "textarea" }],
    },
    {
      required: false,
      label: " Anything else we should know? ",
      fields: [{ name: "question_3", type: "textarea" }],
    },
  ],
};

function fetchFrom(routes: Record<string, unknown>, seen: string[] = []) {
  return (url: string) => {
    seen.push(url);
    const body = routes[url];
    return Promise.resolve(
      body === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  };
}

describe("Greenhouse apply URLs", () => {
  it("name the board and job, on every Greenhouse host", () => {
    expect(greenhouseJob("https://job-boards.greenhouse.io/figma/jobs/6178851004")).toEqual({
      board: "figma",
      job: "6178851004",
    });
    expect(
      greenhouseJob("https://boards.greenhouse.io/figma/jobs/6178851004?gh_jid=6178851004"),
    ).toEqual({ board: "figma", job: "6178851004" });
    expect(
      greenhouseJob("https://boards.greenhouse.io/embed/job_app?for=figma&token=6178851004"),
    ).toEqual({ board: "figma", job: "6178851004" });
  });

  it("are not other sites, including company pages that embed a Greenhouse form", () => {
    expect(greenhouseJob("https://jobs.lever.co/acme/abc")).toBeUndefined();
    expect(greenhouseJob("https://www.figma.com/careers/?gh_jid=6178851004")).toBeUndefined();
    expect(greenhouseJob("not a url")).toBeUndefined();
  });
});

describe("reading a form's free-text questions", () => {
  it("reads a Greenhouse job's open questions and description from its public API", async () => {
    const seen: string[] = [];
    const fetch = fetchFrom(
      {
        "https://boards-api.greenhouse.io/v1/boards/figma/jobs/6178851004?questions=true": figmaJob,
      },
      seen,
    );
    expect(
      await readFormQuestions("https://job-boards.greenhouse.io/figma/jobs/6178851004", fetch),
    ).toEqual({
      kind: "read",
      questions: [
        { question: "Why do you want to join Figma?", required: true },
        { question: "Anything else we should know?", required: false },
      ],
      description:
        "Figma is growing our team of passionate creatives & builders. What you'll do Build data pipelines",
    });
    expect(seen).toHaveLength(1);
  });

  it("says when the questions cannot be read ahead of the form", async () => {
    const fetch = fetchFrom({});
    expect(await readFormQuestions("https://jobs.lever.co/acme/abc", fetch)).toEqual({
      kind: "unsupported",
    });
    expect(await readFormQuestions("https://job-boards.greenhouse.io/figma/jobs/1", fetch)).toEqual(
      { kind: "failed", reason: "Greenhouse answered 404" },
    );
  });

  it("reports a network failure instead of throwing", async () => {
    const fetch = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    expect(await readFormQuestions("https://job-boards.greenhouse.io/figma/jobs/1", fetch)).toEqual(
      { kind: "failed", reason: "getaddrinfo ENOTFOUND" },
    );
  });
});
