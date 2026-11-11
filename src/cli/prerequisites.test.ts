import { describe, expect, it } from "vitest";
import { memoryFillIo } from "../fill/testing/memory-io.ts";
import {
  CLAUDE_EXTENSION_ID,
  SIMPLIFY_EXTENSION_ID,
  runPrerequisites,
  type PrerequisitesIo,
} from "./prerequisites.ts";

const HOME = "/Users/candidate";
const HELIUM = `${HOME}/Library/Application Support/net.imput.helium`;

function extensionFiles(profile: string, settings: Record<string, unknown>) {
  const files: Record<string, string> = {
    [`${HELIUM}/${profile}/Secure Preferences`]: JSON.stringify({ extensions: { settings } }),
  };
  for (const id of Object.keys(settings)) {
    files[`${HELIUM}/${profile}/Extensions/${id}/1.0.0/manifest.json`] = "{}";
  }
  return files;
}

const app = { "/Applications/Helium.app/Contents/Info.plist": "<plist/>" };
const enabled = { disable_reasons: [] };

function setup(
  files: Record<string, string>,
  { platform = "darwin", node = "22.11.0" }: { platform?: string; node?: string } = {},
) {
  const io = memoryFillIo(files, { now: "2026-11-10T15:00:00.000Z", home: HOME });
  const result: PrerequisitesIo & typeof io = Object.assign(io, {
    platform: () => platform,
    nodeVersion: () => node,
  });
  return result;
}

describe("jaa prerequisites", () => {
  it("reports everything ready when Helium has both extensions on", async () => {
    const io = setup({
      ...app,
      ...extensionFiles("Default", {
        [CLAUDE_EXTENSION_ID]: enabled,
        [SIMPLIFY_EXTENSION_ID]: enabled,
      }),
    });
    expect(await runPrerequisites(io)).toBe(0);
    expect(io.out).toContain("Node.js 22.11.0: ready.");
    expect(io.out).toContain("Helium: installed.");
    expect(io.out).toContain("Claude extension in Helium: installed and on.");
    expect(io.out).toContain("Simplify Copilot in Helium: installed and on.");
    expect(io.out).not.toContain("Fix:");
  });

  it("explains how to get Helium when it is missing", async () => {
    const io = setup({});
    expect(await runPrerequisites(io)).toBe(0);
    expect(io.out).toContain("Helium: missing.");
    expect(io.out).toContain("https://helium.computer");
    expect(io.out).toContain("Claude extension in Helium: missing.");
    expect(io.out).toContain(`chromewebstore.google.com/detail/${CLAUDE_EXTENSION_ID}`);
    expect(io.out).toContain("Simplify Copilot in Helium: missing.");
    expect(io.out).toContain(`chromewebstore.google.com/detail/${SIMPLIFY_EXTENSION_ID}`);
  });

  it("finds Helium in the Candidate's own Applications folder", async () => {
    const io = setup({ [`${HOME}/Applications/Helium.app/Contents/Info.plist`]: "<plist/>" });
    await runPrerequisites(io);
    expect(io.out).toContain("Helium: installed.");
  });

  it("says when an extension is installed but turned off", async () => {
    const io = setup({
      ...app,
      ...extensionFiles("Default", {
        [CLAUDE_EXTENSION_ID]: { disable_reasons: [1] },
        [SIMPLIFY_EXTENSION_ID]: enabled,
      }),
    });
    await runPrerequisites(io);
    expect(io.out).toContain("Claude extension in Helium: installed but turned off.");
    expect(io.out).toContain("Manage extensions");
  });

  it("looks in every Helium profile", async () => {
    const io = setup({
      ...app,
      [`${HELIUM}/Local State`]: JSON.stringify({
        profile: { info_cache: { Default: {}, "Profile 1": {} } },
      }),
      ...extensionFiles("Profile 1", {
        [CLAUDE_EXTENSION_ID]: enabled,
        [SIMPLIFY_EXTENSION_ID]: enabled,
      }),
    });
    await runPrerequisites(io);
    expect(io.out).toContain("Claude extension in Helium: installed and on.");
    expect(io.out).toContain("Simplify Copilot in Helium: installed and on.");
  });

  it("does not count an extension whose files are gone", async () => {
    const io = setup({
      ...app,
      [`${HELIUM}/Default/Secure Preferences`]: JSON.stringify({
        extensions: { settings: { [CLAUDE_EXTENSION_ID]: enabled } },
      }),
    });
    await runPrerequisites(io);
    expect(io.out).toContain("Claude extension in Helium: missing.");
  });

  it("warns when the Claude extension is also in Google Chrome, which Fill must not use", async () => {
    const chrome = `${HOME}/Library/Application Support/Google/Chrome`;
    const io = setup({
      ...app,
      ...extensionFiles("Default", { [CLAUDE_EXTENSION_ID]: enabled }),
      [`${chrome}/Default/Secure Preferences`]: JSON.stringify({
        extensions: { settings: { [CLAUDE_EXTENSION_ID]: enabled } },
      }),
      [`${chrome}/Default/Extensions/${CLAUDE_EXTENSION_ID}/1.0.0/manifest.json`]: "{}",
    });
    await runPrerequisites(io);
    expect(io.out).toContain("The Claude extension is also on in Google Chrome.");
    expect(io.out).toContain("Helium");
  });

  it("flags a Node.js older than 20", async () => {
    const io = setup({}, { node: "18.19.0" });
    expect(await runPrerequisites(io)).toBe(1);
    expect(io.out).toContain("Node.js 18.19.0: too old.");
    expect(io.out).toContain("https://nodejs.org");
  });

  it("says Fill needs a Mac on other systems", async () => {
    const io = setup({}, { platform: "win32" });
    expect(await runPrerequisites(io)).toBe(0);
    expect(io.out).toContain("Fill works only on a Mac");
    expect(io.out).not.toContain("Helium: missing.");
  });

  it("leaves the live checks to the skill", async () => {
    const io = setup({});
    await runPrerequisites(io);
    expect(io.out).toContain("Still to check in this session");
  });
});
