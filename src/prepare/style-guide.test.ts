import { describe, expect, it } from "vitest";
import { memoryFillIo } from "../fill/testing/memory-io.ts";
import {
  STYLE_GUIDE_TEMPLATE,
  avoidedPhrasesIn,
  readStyleGuide,
  runStyleGuide,
} from "./style-guide.ts";

const NOW = "2026-11-10T15:00:00.000Z";

const written = `# Style Guide

<!-- Guidance the Candidate never filled in. -->

## Tone

Direct and warm. Short sentences, concrete numbers over adjectives.

## Phrases to avoid

<!-- One per line. -->
- passionate about
- "I am excited to"
- Leverage

## Sample answers

### Why this company?

I have used Acme's tools since high school, so I know where they break.
`;

describe("the Style Guide file", () => {
  it("reads tone, phrases to avoid and sample answers, ignoring the template's guidance", () => {
    expect(readStyleGuide(written)).toEqual({
      tone: "Direct and warm. Short sentences, concrete numbers over adjectives.",
      avoid: ["passionate about", "I am excited to", "Leverage"],
      samples: 1,
    });
  });

  it("starts empty from its template", () => {
    expect(readStyleGuide(STYLE_GUIDE_TEMPLATE)).toEqual({ tone: "", avoid: [], samples: 0 });
  });

  it("finds the avoided phrases a draft uses, ignoring case and spacing", () => {
    const guide = readStyleGuide(written);
    expect(
      avoidedPhrasesIn("I'm PASSIONATE  about tools, and I'd leverage my skills.", guide.avoid),
    ).toEqual(["passionate about", "Leverage"]);
    expect(avoidedPhrasesIn("I built a planner 2,000 students use.", guide.avoid)).toEqual([]);
  });
});

describe("jaa style-guide", () => {
  it("init creates the file from its template and never overwrites it", async () => {
    const io = memoryFillIo({}, { now: NOW });
    expect(await runStyleGuide("init", "style-guide.md", io)).toBe(0);
    expect(await io.readFile("style-guide.md")).toBe(STYLE_GUIDE_TEMPLATE);

    const kept = memoryFillIo({ "style-guide.md": written }, { now: NOW });
    expect(await runStyleGuide("init", "style-guide.md", kept)).toBe(0);
    expect(await kept.readFile("style-guide.md")).toBe(written);
    expect(kept.out).toContain("already exists");
  });

  it("check says what the Style Guide holds", async () => {
    const io = memoryFillIo({ "style-guide.md": written }, { now: NOW });
    expect(await runStyleGuide("check", "style-guide.md", io)).toBe(0);
    expect(io.out).toBe(
      "style-guide.md has a tone, 3 phrases to avoid and 1 sample answer.\n" +
        "Every AI-drafted answer follows it.\n",
    );
  });

  it("check names what is still missing", async () => {
    const io = memoryFillIo({ "style-guide.md": STYLE_GUIDE_TEMPLATE }, { now: NOW });
    expect(await runStyleGuide("check", "style-guide.md", io)).toBe(1);
    expect(io.err).toBe(
      'style-guide.md has no tone yet. Write a few lines under "## Tone" on how you sound; phrases to avoid and sample answers are optional but help.\n',
    );
  });

  it("check points to Setup when there is no file", async () => {
    const io = memoryFillIo({}, { now: NOW });
    expect(await runStyleGuide("check", "style-guide.md", io)).toBe(1);
    expect(io.err).toContain("Run /job-app-assist:setup");
  });

  it("works only inside the Candidate folder", async () => {
    const io = memoryFillIo({}, { now: NOW });
    expect(await runStyleGuide("init", "../style-guide.md", io)).toBe(1);
  });
});
