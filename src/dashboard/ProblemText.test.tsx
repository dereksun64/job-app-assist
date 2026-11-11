// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { ProblemText } from "./ProblemText.tsx";

afterEach(cleanup);

describe("ProblemText", () => {
  it("shows a Toolkit command as code inside the sentence", () => {
    const { container } = render(
      <p>
        <ProblemText text="Full. To make room, ask your Claude to run /job-app-assist:tidy." />
      </p>,
    );
    expect(container.querySelector("code")?.textContent).toBe("/job-app-assist:tidy");
    expect(container.textContent).toBe(
      "Full. To make room, ask your Claude to run /job-app-assist:tidy.",
    );
  });

  it("leaves a sentence without a command as plain text", () => {
    const { container } = render(<ProblemText text="Try again in a moment." />);
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toBe("Try again in a moment.");
  });
});
