import { describe, expect, it } from "vitest";
import { PRIVATE_ANSWERS_TEMPLATE, blankAnswers, runPrivateAnswers } from "./private-answers.ts";
import { memoryFillIo } from "./testing/memory-io.ts";

const NOW = "2026-11-10T15:00:00.000Z";

describe("jaa private-answers init", () => {
  it("creates the private file from the template when it is missing", async () => {
    const io = memoryFillIo({}, { now: NOW });
    expect(await runPrivateAnswers("init", "private-answers.md", io)).toBe(0);
    expect(await io.readFile("private-answers.md")).toBe(PRIVATE_ANSWERS_TEMPLATE);
    expect(io.out).toContain("Created private-answers.md");
    expect(io.out).toContain("never goes to your dashboard");
  });

  it("never overwrites a private file that exists", async () => {
    const io = memoryFillIo({ "private-answers.md": "- Legal first name: Sam\n" }, { now: NOW });
    expect(await runPrivateAnswers("init", "private-answers.md", io)).toBe(0);
    expect(await io.readFile("private-answers.md")).toBe("- Legal first name: Sam\n");
    expect(io.out).toContain("private-answers.md already exists; it was left as it is.");
  });

  it("keeps the file inside the Candidate folder", async () => {
    const io = memoryFillIo({}, { now: NOW });
    expect(await runPrivateAnswers("init", "../elsewhere.md", io)).toBe(1);
    expect(io.err).toContain("inside the Candidate folder");
    expect(io.disk.size).toBe(0);
  });
});

describe("the template", () => {
  it("asks for the sensitive answers application forms need", () => {
    for (const label of [
      "Legal first name",
      "Street address",
      "Authorized to work in the US",
      "Need visa sponsorship now or in the future",
      "Gender",
      "Hispanic or Latino",
      "Veteran status",
      "Disability status",
    ]) {
      expect(PRIVATE_ANSWERS_TEMPLATE).toContain(`- ${label}:`);
    }
  });

  it("starts with every answer blank", () => {
    expect(blankAnswers(PRIVATE_ANSWERS_TEMPLATE).length).toBeGreaterThan(20);
  });
});

describe("jaa private-answers check", () => {
  it("names the blank answers without printing any answer", async () => {
    const text = PRIVATE_ANSWERS_TEMPLATE.replace("- Legal first name:", "- Legal first name: Sam");
    const io = memoryFillIo({ "private-answers.md": text }, { now: NOW });
    expect(await runPrivateAnswers("check", "private-answers.md", io)).toBe(0);
    expect(io.out).not.toContain("Sam");
    expect(io.out).not.toContain("- Legal first name\n");
    expect(io.out).toContain("- Legal last name\n");
    expect(io.out).toMatch(/^private-answers\.md answers \d+ of \d+ questions\./);
    expect(io.out).toContain("Fill leaves these blank on a form and flags them for you:");
  });

  it("says so when every question is answered", async () => {
    const io = memoryFillIo({ "private-answers.md": "- Legal first name: Sam\n" }, { now: NOW });
    expect(await runPrivateAnswers("check", "private-answers.md", io)).toBe(0);
    expect(io.out).toBe("private-answers.md answers every question.\n");
  });

  it("sends the Candidate to Setup when the file is missing", async () => {
    const io = memoryFillIo({}, { now: NOW });
    expect(await runPrivateAnswers("check", "private-answers.md", io)).toBe(1);
    expect(io.err).toContain("/job-app-assist:setup");
  });
});
