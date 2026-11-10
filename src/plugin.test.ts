import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

const plugin = readJson("plugin/.claude-plugin/plugin.json") as { name: string; version: string };
const marketplace = readJson(".claude-plugin/marketplace.json") as {
  plugins: { name: string; source: string }[];
};
const skills = readdirSync(`${root}plugin/skills`);

function frontmatter(skill: string): Record<string, string> {
  const text = read(`plugin/skills/${skill}/SKILL.md`);
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
}

describe("plugin package", () => {
  it("is listed in the repo's own marketplace under the same name", () => {
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({ name: plugin.name, source: "./plugin" }),
    );
  });

  it("ships the built dashboard page stamped with the plugin version", () => {
    expect(read("plugin/dist/dashboard.html")).toContain(
      `<meta name="job-app-assist:page-version" content="${plugin.version}">`,
    );
  });

  it("ships the contract CLI that skills run", () => {
    expect(existsSync(`${root}plugin/dist/jaa.mjs`)).toBe(true);
  });

  it("has the hard-rules skill", () => {
    expect(skills).toContain("hard-rules");
  });
});

describe.each(skills)("skill %s", (skill) => {
  it("names itself after its directory and has a description", () => {
    const meta = frontmatter(skill);
    expect(meta.name).toBe(skill);
    expect(meta.description?.length).toBeGreaterThan(40);
  });
});

describe.each(skills.filter((skill) => skill !== "hard-rules"))("skill %s", (skill) => {
  it("loads the hard rules as its first step", () => {
    const body = read(`plugin/skills/${skill}/SKILL.md`);
    const firstStep = /^## 1\. .*\n\n(.*)$/m.exec(body)?.[1] ?? "";
    expect(firstStep).toContain(
      "Invoke the `job-app-assist:hard-rules` skill before anything else",
    );
  });
});

describe("authored text", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      // Generated files and fixtures copied verbatim from real data are not authored text.
      (path) =>
        path !== "" &&
        !path.startsWith("plugin/dist/") &&
        !path.includes("/fixtures/") &&
        path !== "package-lock.json",
    )
    .filter((path) => existsSync(`${root}${path}`));

  it.each(files)("%s uses plain dashes only", (path) => {
    expect(read(path)).not.toMatch(/[\u2013\u2014]/);
  });
});
