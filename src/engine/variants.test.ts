import { describe, expect, it } from "vitest";
import type { ResumeVariant } from "../contract/index.ts";
import { pickResumeVariant, type VariantEvidence } from "./variants.ts";

const generalist: ResumeVariant = {
  name: "Generalist SWE",
  roleTypes: ["Software Engineer"],
  keywords: ["full stack", "generalist"],
};
const backend: ResumeVariant = {
  name: "Backend SWE/SDE",
  roleTypes: ["Software Engineer"],
  keywords: ["backend", "back-end", "distributed systems", "infrastructure", "API", "platform"],
};
const ml: ResumeVariant = {
  name: "AI/ML Engineer",
  roleTypes: ["Machine Learning Engineer"],
  keywords: ["machine learning", "ML", "AI", "LLM", "deep learning"],
};
const original = [generalist, backend, ml];

function evidence(overrides: Partial<VariantEvidence> = {}): VariantEvidence {
  return { title: "Software Engineer, New Grad", roleType: "Software Engineer", ...overrides };
}

describe("pickResumeVariant", () => {
  it("always picks the only Resume Variant, confidently", () => {
    const only: ResumeVariant = { name: "My resume", roleTypes: [], keywords: [] };
    expect(pickResumeVariant(evidence({ title: "Product Manager" }), [only])).toEqual({
      pick: { name: "My resume", reason: "Your only Resume Variant." },
      confident: true,
    });
  });

  it("picks the variant whose keyword the title mentions", () => {
    expect(pickResumeVariant(evidence({ title: "Backend Engineer, New Grad" }), original)).toEqual({
      pick: {
        name: "Backend SWE/SDE",
        reason: 'The title mentions "backend"; made for Software Engineer roles.',
      },
      confident: true,
    });
  });

  it("names every keyword the title mentions, a few at most", () => {
    const { pick } = pickResumeVariant(
      evidence({ title: "Backend Platform Engineer, Distributed Systems and API Infrastructure" }),
      original,
    );
    expect(pick.name).toBe("Backend SWE/SDE");
    expect(pick.reason).toBe(
      'The title mentions "backend", "distributed systems" and "infrastructure"; made for Software Engineer roles.',
    );
  });

  it("picks the variant made for the Posting's role type", () => {
    expect(
      pickResumeVariant(
        evidence({ title: "Applied Scientist Intern", roleType: "Machine Learning Engineer" }),
        original,
      ),
    ).toEqual({
      pick: {
        name: "AI/ML Engineer",
        reason:
          "Made for Machine Learning Engineer roles; the title reads as a machine learning role.",
      },
      confident: true,
    });
  });

  it("uses the default, listed first, when a plain title fits several variants equally", () => {
    expect(pickResumeVariant(evidence(), original)).toEqual({
      pick: {
        name: "Generalist SWE",
        reason:
          "Made for Software Engineer roles, which fits Generalist SWE and Backend SWE/SDE equally; Generalist SWE is your default.",
      },
      confident: true,
    });
  });

  it("is unsure when two variants other than the default tie", () => {
    const { pick, confident } = pickResumeVariant(
      evidence({ title: "ML Platform Engineer", roleType: "Machine Learning Engineer" }),
      [generalist, { ...backend, roleTypes: ["Machine Learning Engineer"] }, ml],
    );
    expect(confident).toBe(false);
    expect(pick.name).toBe("Backend SWE/SDE");
    expect(pick.reason).toMatch(/^Close call between Backend SWE\/SDE and AI\/ML Engineer: /);
  });

  it("is unsure when the winner leads by a single point", () => {
    const { pick, confident } = pickResumeVariant(
      evidence({ title: "Software Engineer", description: "You will design a REST API." }),
      original,
    );
    expect(pick.name).toBe("Backend SWE/SDE");
    expect(confident).toBe(false);
    expect(pick.reason).toBe(
      'Close call between Backend SWE/SDE and Generalist SWE: made for Software Engineer roles; the title reads as a software role; the listing mentions "API".',
    );
  });

  it("reads keywords from the description and the Source's category", () => {
    const { pick, confident } = pickResumeVariant(
      evidence({
        title: "Software Engineer",
        description: "Own backend services and the distributed systems behind our public API.",
      }),
      original,
    );
    expect(pick.name).toBe("Backend SWE/SDE");
    expect(confident).toBe(true);
    expect(pick.reason).toBe(
      'Made for Software Engineer roles; the title reads as a software role; the listing mentions "backend", "distributed systems" and "API".',
    );
    const byCategory = pickResumeVariant(
      evidence({
        title: "Engineer Intern",
        roleType: "Machine Learning Engineer",
        category: "AI/ML",
      }),
      [generalist, backend, { ...ml, roleTypes: [] }],
    );
    expect(byCategory.pick.name).toBe("AI/ML Engineer");
  });

  it("falls back to the default, unsure, when nothing points to a variant", () => {
    expect(
      pickResumeVariant(evidence({ title: "Product Manager, New Grad", roleType: "PM" }), original),
    ).toEqual({
      pick: {
        name: "Generalist SWE",
        reason: "Nothing in the title or listing points to a variant, so it uses your default.",
      },
      confident: false,
    });
  });

  it("matches whole words, so ML is not found in HTML and C++ is found as written", () => {
    const html = pickResumeVariant(evidence({ title: "HTML Email Developer", roleType: "Other" }), [
      generalist,
      ml,
    ]);
    expect(html.pick.name).toBe("Generalist SWE");
    const cpp = pickResumeVariant(evidence({ title: "C++ Developer Intern", roleType: "Other" }), [
      generalist,
      { name: "Systems", roleTypes: [], keywords: ["C++"] },
    ]);
    expect(cpp.pick).toEqual({ name: "Systems", reason: 'The title mentions "C++".' });
  });

  it("lets a keyword in the title outweigh the default's role type", () => {
    const { pick, confident } = pickResumeVariant(
      evidence({ title: "Software Dev Engineer I - Security Platform" }),
      [generalist, { ...backend, roleTypes: [] }, ml],
    );
    expect(pick.name).toBe("Backend SWE/SDE");
    expect(confident).toBe(true);
  });

  it("treats hyphens and spaces in keywords alike", () => {
    const { pick } = pickResumeVariant(
      evidence({ title: "Full-Stack Engineer", roleType: "Other" }),
      [{ name: "Default", roleTypes: [], keywords: [] }, generalist],
    );
    expect(pick).toEqual({ name: "Generalist SWE", reason: 'The title mentions "full stack".' });
  });

  it("matches keywords and role types ignoring case", () => {
    const { pick } = pickResumeVariant(
      evidence({ title: "LLM Research Engineer", roleType: "machine learning engineer" }),
      original,
    );
    expect(pick.name).toBe("AI/ML Engineer");
  });

  it("keeps every reason within the contract's limit", () => {
    const wordy: ResumeVariant = {
      name: "W".repeat(60),
      roleTypes: ["R".repeat(120)],
      keywords: ["k".repeat(120), "j".repeat(120), "i".repeat(120)],
    };
    const { pick } = pickResumeVariant(
      evidence({
        title: `${"k".repeat(120)} ${"j".repeat(120)} ${"i".repeat(120)}`,
        roleType: "R".repeat(120),
      }),
      [{ ...wordy, name: "V".repeat(60) }, wordy],
    );
    expect(pick.reason.length).toBeLessThanOrEqual(300);
  });
});
