import { describe, expect, it } from "vitest";
import type { RoleType } from "../contract/index.ts";
import { levelOf, matchRoleType, startWindowOf, withinStartWindow } from "./roles.ts";

describe("levelOf", () => {
  it.each([
    ["Software Engineer Intern", "internship", "intern"],
    ["Embedded Systems Co-Op", "internship", "intern"],
    ["Software Engineer", "internship", "intern"],
    ["Software Engineer, New Grad", "full-time", "new_grad"],
    ["Quantitative Trader - University Graduate", "full-time", "new_grad"],
    ["Entry Level Software Tester", "full-time", "new_grad"],
    ["Backend Engineer", "full-time", "new_grad"],
    ["Software Engineer I", "full-time", "junior"],
    ["Software Developer Engineer 1", "full-time", "junior"],
    ["Junior Full Stack Engineer", "full-time", "junior"],
    ["Associate Software Engineer", "full-time", "junior"],
    ["Member of Technical Staff", "full-time", "new_grad"],
  ] as const)("reads %s (%s) as %s", (title, jobType, level) => {
    expect(levelOf(title, jobType)).toBe(level);
  });

  it("asks for a stated level when the Source lists jobs at every level", () => {
    const stated = { stated: true };
    expect(levelOf("Software Engineer, Agent Platform", "", stated)).toBeUndefined();
    expect(levelOf("Backend Engineer", "full-time", stated)).toBeUndefined();
    expect(levelOf("Software Engineer, New Grad", "", stated)).toBe("new_grad");
    expect(levelOf("Software Engineer I", "", stated)).toBe("junior");
    expect(levelOf("Software Engineer, Data Connectors", "Internship", stated)).toBe("intern");
    expect(levelOf("Research Engineer", "Intern", stated)).toBe("intern");
  });

  it("trusts the title over a Source that mislabels a new-grad role as an internship", () => {
    expect(levelOf("Engineer 2 New Grad - Multiple Teams", "internship")).toBe("new_grad");
    expect(levelOf("Software Engineer Intern", "full-time")).toBe("intern");
    expect(levelOf("Graduate Engineer Intern - Software Development", "internship")).toBe("intern");
  });

  it.each([
    "Senior Software Engineer",
    "Sr. Backend Engineer",
    "Staff Machine Learning Engineer",
    "Principal Engineer",
    "Software Engineer II",
    "Software Engineer III, Payments",
    "Lead Software Engineer",
    "Engineering Manager, Infrastructure",
    "Security Architect",
    "Experienced Software Engineer",
  ])("excludes %s as asking for more experience", (title) => {
    expect(levelOf(title, "full-time")).toBeUndefined();
  });

  it("keeps a senior-sounding title that is explicitly entry level", () => {
    expect(levelOf("New Grad 2027: Engineer II, Software - Full Stack", "full-time")).toBe(
      "new_grad",
    );
    expect(levelOf("Senior Machine Learning Engineer - PhD Early Career", "full-time")).toBe(
      "new_grad",
    );
    expect(levelOf("Machine Learning Engineer Intern, Lead Ads", "internship")).toBe("intern");
  });
});

describe("matchRoleType", () => {
  const roleTypes: RoleType[] = [
    { name: "Software Engineer", priority: "high" },
    { name: "Machine Learning Engineer", priority: "high" },
    { name: "SDE", priority: "medium" },
    { name: "Product Manager (new grad program)", priority: "low" },
    { name: "Technical Program Manager", priority: "low" },
  ];
  const match = (title: string, category = "") => matchRoleType(title, category, roleTypes)?.name;

  it.each([
    ["Software Engineer Intern", "Software Engineer"],
    ["Backend Developer", "Software Engineer"],
    ["Full-Stack Engineer, Payments", "Software Engineer"],
    ["iOS Engineer New Grad", "Software Engineer"],
    ["Member of Technical Staff", "Software Engineer"],
    ["Machine Learning Engineer Intern", "Machine Learning Engineer"],
    ["AI Research Intern", "Machine Learning Engineer"],
    ["New Grad 2027: Research Scientist (Seed Model - LLM)", "Machine Learning Engineer"],
    ["Associate Product Manager New Grad", "Product Manager (new grad program)"],
    ["Technical Program Manager, University Grad", "Technical Program Manager"],
  ])("matches %s to %s", (title, roleType) => {
    expect(match(title)).toBe(roleType);
  });

  it("prefers the highest-priority role type a title fits", () => {
    expect(match("Software Development Engineer Intern")).toBe("Software Engineer");
    const mlFirst: RoleType[] = [
      { name: "Software Engineer", priority: "medium" },
      { name: "ML Engineer", priority: "high" },
    ];
    expect(matchRoleType("Software Engineer, Machine Learning", "", mlFirst)?.name).toBe(
      "ML Engineer",
    );
  });

  it.each([
    "Mechanical Engineering Intern",
    "Accounting Intern",
    "Electrical Engineering Intern - FPGA",
    "Product Designer",
    "Quant Trading Intern",
  ])("leaves %s unmatched", (title) => {
    expect(match(title)).toBeUndefined();
  });

  it("falls back to the Source's category only when the title names no role", () => {
    expect(match("Intern - Multiple Teams", "AI/ML")).toBe("Machine Learning Engineer");
    expect(match("Graduate Intern", "Software Engineering")).toBe("Software Engineer");
    expect(match("Product Yield Software Engineer Intern", "Product")).toBe("Software Engineer");
    expect(match("Accounting Intern", "Software Engineering")).toBeUndefined();
  });

  it("matches a role type outside the known families by its words", () => {
    const custom: RoleType[] = [{ name: "Robotics Engineer", priority: "high" }];
    expect(matchRoleType("Robotics Intern, Manipulation", "", custom)?.name).toBe(
      "Robotics Engineer",
    );
    expect(matchRoleType("Software Engineer", "", custom)).toBeUndefined();
  });
});

describe("start window", () => {
  it.each([
    ["Software Engineer Intern - Summer 2027", { from: "2027-05", to: "2027-09" }],
    ["Embedded Software Developer Intern - Winter 2027", { from: "2027-01", to: "2027-03" }],
    ["Robot Software Engineer Intern - Spring & Summer 2027", { from: "2027-01", to: "2027-09" }],
    ["Fall 2026 Co-op", { from: "2026-08", to: "2026-12" }],
    ["New Grad 2027: Backend Software Engineer", { from: "2027-01", to: "2027-12" }],
    ["2026-2027 Rotational Program", { from: "2026-01", to: "2027-12" }],
    ["Software Engineer Intern", undefined],
    ["Entry Level Software Tester - 2608-2", undefined],
  ])("reads %s", (title, window) => {
    expect(startWindowOf(title)).toEqual(window);
  });

  it("keeps Postings whose start overlaps the Candidate's window or is unknown", () => {
    const window = { earliest: "2027-01", latest: "2027-12" };
    expect(withinStartWindow("Software Engineer Intern - Summer 2027", window)).toBe(true);
    expect(withinStartWindow("Software Engineer Intern", window)).toBe(true);
    expect(withinStartWindow("Software Engineer Intern - Summer 2026", window)).toBe(false);
    expect(withinStartWindow("2026 New Grad Software Engineer", window)).toBe(false);
    expect(withinStartWindow("Software Engineer Intern - Summer 2028", window)).toBe(false);
    expect(withinStartWindow("Fall 2026 Co-op", { latest: "2026-09" })).toBe(true);
    expect(withinStartWindow("Summer 2026 Intern", {})).toBe(true);
  });
});
