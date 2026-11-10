// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateSettings, type Settings } from "../contract/index.ts";
import { App } from "./App.tsx";
import { createMemoryDb, type MemoryDb } from "./testing/memory-db.ts";

const NOW = Date.parse("2026-11-10T15:00:00.000Z");
const NOW_ISO = "2026-11-10T15:00:00.000Z";

const settings: Settings = {
  schemaVersion: 1,
  searchProfile: {
    roleTypes: [
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "medium" },
    ],
    seniority: ["new_grad"],
    startWindow: {},
    locationTiers: [{ locations: ["New York City", "Remote"] }, { locations: ["Boston"] }],
  },
  resumeVariants: [
    { name: "Generalist SWE", roleTypes: [], keywords: [] },
    { name: "AI/ML Engineer", roleTypes: ["Machine Learning Engineer"], keywords: [] },
  ],
  dailyQueueTarget: 20,
  companies: { boost: ["OpenAI"], lower: [], block: ["Palantir"] },
  blockedApplySites: [],
  freshnessWeight: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
});

async function openPanel(
  initial: object = settings,
  options: Parameters<typeof createMemoryDb>[1] = {},
): Promise<MemoryDb> {
  const db = createMemoryDb({ "settings/main": initial }, options);
  render(<App db={db} pageVersion="1.2.3" now={NOW} />);
  await screen.findByRole("tablist");
  await act(() => Promise.resolve());
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  return db;
}

const panel = () => screen.getByRole("dialog", { name: "Settings" });
const region = (name: string) => within(panel()).getByRole("region", { name });
const saved = (db: MemoryDb) => db.contents()["settings/main"] as Settings;
const status = () => within(panel()).getByRole("status");

/** The one settings write so far, checked against the contract. */
function onlyWrite(db: MemoryDb): Settings {
  expect(db.writes).toHaveLength(1);
  const [write] = db.writes;
  if (write?.op !== "set") throw new Error("expected a set");
  expect(write.path).toBe("settings/main");
  const result = validateSettings(write.data);
  if (!result.ok) throw new Error(result.issues.join("\n"));
  expect(write.data).toEqual(result.value);
  return result.value;
}

describe("Settings panel", () => {
  it("opens from the tab bar beside Sources and shows the current settings", async () => {
    await openPanel();
    expect(panel()).toBeVisible();
    expect(within(region("Daily Queue target")).getByRole("spinbutton")).toHaveValue(20);
    const roles = within(region("Role types")).getAllByRole("radiogroup");
    expect(roles.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Software Engineer priority",
      "Machine Learning Engineer priority",
    ]);
    expect(within(roles[0] as HTMLElement).getByRole("radio", { name: "High" })).toBeChecked();
    expect(within(roles[1] as HTMLElement).getByRole("radio", { name: "Medium" })).toBeChecked();
    const tiers = within(region("Location Tiers")).getAllByRole("list");
    expect(tiers.map((tier) => tier.getAttribute("aria-label"))).toEqual(["Tier 1", "Tier 2"]);
    expect(
      within(tiers[0] as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("New York City"), expect.stringContaining("Remote")]);
    expect(within(region("Companies")).getByRole("list", { name: "Boosted" })).toHaveTextContent(
      "OpenAI",
    );
    expect(within(region("Companies")).getByRole("list", { name: "Blocked" })).toHaveTextContent(
      "Palantir",
    );
    expect(region("Companies")).toHaveTextContent("No lowered companies.");
    expect(region("Blocked apply sites")).toHaveTextContent("No blocked sites.");
    expect(within(region("Freshness weight")).getByRole("slider")).toHaveValue("20");
    expect(region("Freshness weight")).toHaveTextContent("20%");
  });

  it("fills in defaults for settings saved before company rules existed", async () => {
    const older: Partial<Settings> = { ...settings };
    delete older.companies;
    delete older.blockedApplySites;
    delete older.freshnessWeight;
    await openPanel(older);
    expect(region("Companies")).toHaveTextContent("No boosted companies.");
    expect(within(region("Freshness weight")).getByRole("slider")).toHaveValue("20");
  });

  it("closes with its close button and with Escape", async () => {
    await openPanel();
    await userEvent.click(within(panel()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent(panel(), new Event("close"));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("tells the Candidate when there are no settings yet", async () => {
    const db = createMemoryDb({});
    render(<App db={db} pageVersion="1.2.3" now={NOW} />);
    await screen.findByRole("tablist");
    await act(() => Promise.resolve());
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(panel()).toHaveTextContent("Setup isn't finished");
    expect(within(panel()).queryByRole("region")).toBeNull();
  });
});

describe("daily Queue target", () => {
  it("saves a new target when the field is committed, and says what changed", async () => {
    const db = await openPanel();
    const field = within(region("Daily Queue target")).getByRole("spinbutton");
    await userEvent.clear(field);
    await userEvent.type(field, "12{Enter}");
    expect(onlyWrite(db)).toEqual({ ...settings, dailyQueueTarget: 12, updatedAt: NOW_ISO });
    expect(status()).toHaveTextContent("Saved: Daily Queue target: 20 → 12.");
  });

  it("refuses a target outside 1 to 100 and saves nothing", async () => {
    const db = await openPanel();
    const field = within(region("Daily Queue target")).getByRole("spinbutton");
    await userEvent.clear(field);
    await userEvent.type(field, "0");
    field.blur();
    await act(() => Promise.resolve());
    expect(db.writes).toEqual([]);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(region("Daily Queue target")).toHaveTextContent("Enter a whole number from 1 to 100.");
  });
});

describe("role types", () => {
  it("changes a role type's priority", async () => {
    const db = await openPanel();
    const group = within(region("Role types")).getByRole("radiogroup", {
      name: "Machine Learning Engineer priority",
    });
    await userEvent.click(within(group).getByRole("radio", { name: "Low" }));
    expect(onlyWrite(db).searchProfile.roleTypes).toEqual([
      { name: "Software Engineer", priority: "high" },
      { name: "Machine Learning Engineer", priority: "low" },
    ]);
    expect(status()).toHaveTextContent(
      "Saved: Role types: Machine Learning Engineer from medium to low priority.",
    );
  });

  it("adds a role type at the priority chosen for it", async () => {
    const db = await openPanel();
    const roles = region("Role types");
    await userEvent.type(within(roles).getByLabelText("New role type"), "Product Manager");
    await userEvent.selectOptions(within(roles).getByLabelText("Priority"), "low");
    await userEvent.click(within(roles).getByRole("button", { name: "Add role type" }));
    expect(onlyWrite(db).searchProfile.roleTypes).toEqual([
      ...settings.searchProfile.roleTypes,
      { name: "Product Manager", priority: "low" },
    ]);
    expect(within(roles).getByLabelText("New role type")).toHaveValue("");
  });

  it("refuses a role type already listed, ignoring case", async () => {
    const db = await openPanel();
    const roles = region("Role types");
    await userEvent.type(within(roles).getByLabelText("New role type"), "software engineer{Enter}");
    expect(db.writes).toEqual([]);
    expect(roles).toHaveTextContent("Software Engineer is already one of your role types.");
  });

  it("keeps a role type a Resume Variant is aimed at, and says why", async () => {
    const db = await openPanel();
    await userEvent.click(
      within(region("Role types")).getByRole("button", {
        name: "Remove Machine Learning Engineer",
      }),
    );
    expect(db.writes).toEqual([]);
    expect(region("Role types")).toHaveTextContent(
      "Machine Learning Engineer stays while AI/ML Engineer is aimed at it. Ask your Claude to change your Resume Variants first.",
    );
  });

  it("removes a role type, but never the last one", async () => {
    const db = await openPanel({
      ...settings,
      resumeVariants: [{ name: "Generalist SWE", roleTypes: [], keywords: [] }],
    });
    const roles = region("Role types");
    await userEvent.click(
      within(roles).getByRole("button", { name: "Remove Machine Learning Engineer" }),
    );
    expect(saved(db).searchProfile.roleTypes).toEqual([
      { name: "Software Engineer", priority: "high" },
    ]);
    expect(within(roles).getByRole("button", { name: "Remove Software Engineer" })).toBeDisabled();
  });
});

describe("Location Tiers", () => {
  it("adds a location to a tier", async () => {
    const db = await openPanel();
    const tiers = region("Location Tiers");
    await userEvent.type(
      within(tiers).getByLabelText("Add a location to Tier 2"),
      "Seattle{Enter}",
    );
    expect(onlyWrite(db).searchProfile.locationTiers).toEqual([
      { locations: ["New York City", "Remote"] },
      { locations: ["Boston", "Seattle"] },
    ]);
    expect(status()).toHaveTextContent("Saved: Location Tiers: added Seattle to Tier 2.");
  });

  it("refuses a location that is already in a tier", async () => {
    const db = await openPanel();
    const tiers = region("Location Tiers");
    await userEvent.type(within(tiers).getByLabelText("Add a location to Tier 2"), "remote{Enter}");
    expect(db.writes).toEqual([]);
    expect(tiers).toHaveTextContent("Remote is already in Tier 1.");
  });

  it("removes a location, and the tier with its last location", async () => {
    const db = await openPanel();
    const tiers = region("Location Tiers");
    await userEvent.click(within(tiers).getByRole("button", { name: "Remove Remote from Tier 1" }));
    await userEvent.click(within(tiers).getByRole("button", { name: "Remove Boston from Tier 2" }));
    expect(saved(db).searchProfile.locationTiers).toEqual([{ locations: ["New York City"] }]);
    expect(
      within(tiers).getByRole("button", { name: "Remove New York City from Tier 1" }),
    ).toBeDisabled();
  });

  it("adds a new tier from its first location", async () => {
    const db = await openPanel();
    const tiers = region("Location Tiers");
    await userEvent.type(within(tiers).getByLabelText("Start Tier 3 with a location"), "Austin");
    await userEvent.click(within(tiers).getByRole("button", { name: "Add Tier 3" }));
    expect(saved(db).searchProfile.locationTiers).toEqual([
      ...settings.searchProfile.locationTiers,
      { locations: ["Austin"] },
    ]);
  });
});

describe("company boosts and blocks", () => {
  it("adds a company with a rule", async () => {
    const db = await openPanel();
    const companies = region("Companies");
    await userEvent.type(within(companies).getByLabelText("Company"), "Lockheed Martin");
    await userEvent.selectOptions(within(companies).getByLabelText("Rule"), "lower");
    await userEvent.click(within(companies).getByRole("button", { name: "Add company" }));
    expect(onlyWrite(db).companies).toEqual({
      boost: ["OpenAI"],
      lower: ["Lockheed Martin"],
      block: ["Palantir"],
    });
    expect(within(companies).getByRole("list", { name: "Lowered" })).toHaveTextContent(
      "Lockheed Martin",
    );
    expect(status()).toHaveTextContent("Saved: Companies: lower Lockheed Martin.");
  });

  it("moves a company that already has a rule to the new one", async () => {
    const db = await openPanel();
    const companies = region("Companies");
    await userEvent.type(within(companies).getByLabelText("Company"), "palantir");
    await userEvent.selectOptions(within(companies).getByLabelText("Rule"), "lower");
    await userEvent.click(within(companies).getByRole("button", { name: "Add company" }));
    expect(onlyWrite(db).companies).toEqual({ boost: ["OpenAI"], lower: ["palantir"], block: [] });
    expect(status()).toHaveTextContent("Saved: Companies: palantir from block to lower.");
  });

  it("removes a company's rule", async () => {
    const db = await openPanel();
    await userEvent.click(
      within(region("Companies")).getByRole("button", { name: "Remove OpenAI from Boosted" }),
    );
    expect(saved(db).companies.boost).toEqual([]);
    expect(region("Companies")).toHaveTextContent("No boosted companies.");
  });
});

describe("blocked apply sites", () => {
  it("blocks a site by host name, taking the host from a pasted link", async () => {
    const db = await openPanel();
    const sites = region("Blocked apply sites");
    await userEvent.type(
      within(sites).getByLabelText("Site"),
      "https://MyWorkdayJobs.com/en-US/careers{Enter}",
    );
    expect(onlyWrite(db).blockedApplySites).toEqual(["myworkdayjobs.com"]);
    expect(within(sites).getByRole("list", { name: "Blocked sites" })).toHaveTextContent(
      "myworkdayjobs.com",
    );
    await userEvent.click(within(sites).getByRole("button", { name: "Unblock myworkdayjobs.com" }));
    expect(saved(db).blockedApplySites).toEqual([]);
  });

  it("refuses text that is not a site", async () => {
    const db = await openPanel();
    const sites = region("Blocked apply sites");
    await userEvent.type(within(sites).getByLabelText("Site"), "workday{Enter}");
    expect(db.writes).toEqual([]);
    expect(sites).toHaveTextContent("Enter a site's host name, such as myworkdayjobs.com.");
  });
});

describe("freshness weight", () => {
  it("shows the weight while it moves and saves it when it settles", async () => {
    const db = await openPanel();
    const slider = within(region("Freshness weight")).getByRole("slider");
    fireEvent.input(slider, { target: { value: "35" } });
    expect(region("Freshness weight")).toHaveTextContent("35%");
    expect(db.writes).toEqual([]);
    fireEvent.change(slider, { target: { value: "35" } });
    await act(() => Promise.resolve());
    expect(onlyWrite(db).freshnessWeight).toBe(35);
    expect(await within(panel()).findByText("Saved: Freshness weight: 20% → 35%.")).toHaveAttribute(
      "role",
      "status",
    );
  });
});

describe("one settings document", () => {
  it("shows changes Tune saves while the panel is open, and builds on them", async () => {
    const db = await openPanel();
    await act(async () => {
      await db.doc("settings/main").set({
        ...settings,
        companies: { boost: ["OpenAI", "Anthropic"], lower: [], block: ["Palantir"] },
        updatedAt: "2026-11-10T14:00:00.000Z",
      });
    });
    expect(within(region("Companies")).getByRole("list", { name: "Boosted" })).toHaveTextContent(
      "Anthropic",
    );
    const field = within(region("Daily Queue target")).getByRole("spinbutton");
    await userEvent.clear(field);
    await userEvent.type(field, "15{Enter}");
    expect(saved(db)).toMatchObject({
      dailyQueueTarget: 15,
      companies: { boost: ["OpenAI", "Anthropic"] },
    });
  });

  it("keeps fields the panel does not edit", async () => {
    const db = await openPanel({
      ...settings,
      searchProfile: { ...settings.searchProfile, startWindow: { earliest: "2027-01" } },
    });
    await userEvent.click(
      within(region("Companies")).getByRole("button", { name: "Remove Palantir from Blocked" }),
    );
    expect(saved(db).searchProfile.startWindow).toEqual({ earliest: "2027-01" });
  });

  it("says plainly when a change could not be saved", async () => {
    const db = await openPanel(settings, {
      failWritesWith: { code: "quota_exceeded", message: "full" },
    });
    await userEvent.click(
      within(region("Companies")).getByRole("button", { name: "Remove OpenAI from Boosted" }),
    );
    expect(db.writes).toEqual([]);
    expect(within(panel()).getByRole("alert")).toHaveTextContent(
      "Your dashboard storage is full, so this change wasn't saved.",
    );
    expect(within(region("Companies")).getByRole("list", { name: "Boosted" })).toHaveTextContent(
      "OpenAI",
    );
  });
});
