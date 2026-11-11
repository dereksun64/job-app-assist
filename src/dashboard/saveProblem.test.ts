import { describe, expect, it } from "vitest";
import { saveProblem } from "./saveProblem.ts";

describe("saveProblem", () => {
  it("says the storage is full and how to make room", () => {
    expect(saveProblem({ code: "quota_exceeded", message: "documents in this database" })).toBe(
      "Your dashboard storage is full, so this change wasn't saved. To make room, ask your Claude to run /job-app-assist:tidy.",
    );
  });

  it("sends an organization-wide limit to the claude.ai admin", () => {
    expect(
      saveProblem({ code: "quota_exceeded", message: "the organization's databases are full" }),
    ).toBe(
      "Your organization's claude.ai storage for dashboards is full, so this change wasn't saved. Ask your claude.ai admin to make room.",
    );
  });

  it("tells a rate limit apart from a full database", () => {
    expect(saveProblem({ code: "resource_exhausted", message: "slow down" })).toBe(
      "Too many changes at once, so this one wasn't saved. Wait a moment and try again.",
    );
  });

  it("passes on what was wrong with a refused change", () => {
    expect(saveProblem({ code: "invalid_argument", message: "a document over 256 KiB" })).toBe(
      "This change wasn't saved: a document over 256 KiB",
    );
  });

  it("asks to try again when the data can't be reached", () => {
    const retry =
      "This change wasn't saved because your dashboard data can't be reached. Try again in a moment.";
    expect(saveProblem({ code: "unavailable", message: "" })).toBe(retry);
    expect(saveProblem(new Error("network"))).toBe(retry);
    expect(saveProblem(undefined)).toBe(retry);
  });
});
