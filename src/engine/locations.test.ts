import { describe, expect, it } from "vitest";
import { locationTierOf, parseLocations, unmatchedTierLocations } from "./locations.ts";

const display = (raw: string) => parseLocations(raw).map((place) => place.label);

describe("parseLocations", () => {
  it.each([
    ["San Jose, CA", ["San Jose, CA"]],
    ["NYC", ["New York, NY"]],
    ["SF", ["San Francisco, CA"]],
    ["South SF", ["South San Francisco, CA"]],
    ["LA", ["Los Angeles, CA"]],
    ["New York City, NY", ["New York, NY"]],
    ["Toronto, ON, Canada", ["Toronto, ON, Canada"]],
    ["London, UK", ["London, UK"]],
    ["Remote", ["Remote"]],
    ["Remote in USA", ["Remote in USA"]],
    ["RemoteUnited States", ["Remote in United States"]],
    ["United States", ["United States"]],
    ["North Carolina", ["North Carolina"]],
  ])("reads %s", (raw, expected) => {
    expect(display(raw)).toEqual(expected);
  });

  it("splits the Job Feed's run-together location lists", () => {
    expect(
      display(
        "5 locationsBoston, MASeattle, WAAustin, TXArlington County, Arlington, VADenver, CO",
      ),
    ).toEqual(["Boston, MA", "Seattle, WA", "Austin, TX", "Arlington, VA", "Denver, CO"]);
    expect(display("Seattle, WASFLANYCSunnyvale, CA")).toEqual([
      "Seattle, WA",
      "San Francisco, CA",
      "Los Angeles, CA",
      "New York, NY",
      "Sunnyvale, CA",
    ]);
    expect(display("Palo Alto, CALA")).toEqual(["Palo Alto, CA", "Los Angeles, CA"]);
    expect(display("SFRemote in USA")).toEqual(["San Francisco, CA", "Remote in USA"]);
    expect(display("Remote in USASterling, VADenver, CO")).toEqual([
      "Remote in USA",
      "Sterling, VA",
      "Denver, CO",
    ]);
    expect(display("4 locationsLondon, UKAmsterdam, NetherlandsNYCSingapore")).toEqual([
      "London, UK",
      "Amsterdam, Netherlands",
      "New York, NY",
      "Singapore",
    ]);
    expect(display("Tempe, AZMcLean, VA")).toEqual(["Tempe, AZ", "McLean, VA"]);
    expect(display("FloridaGeorgia")).toEqual(["Florida", "Georgia"]);
    expect(display("Washington, DCVermont")).toEqual(["Washington, DC", "Vermont"]);
    expect(display("CanadaSanta Clara, CAUnited States")).toEqual([
      "Canada",
      "Santa Clara, CA",
      "United States",
    ]);
  });

  it("keeps a location it cannot read as written", () => {
    expect(display("Hybrid - Lagos")).toEqual(["Hybrid - Lagos"]);
  });

  it("drops repeats and blanks", () => {
    expect(display("NYCNew York, NY")).toEqual(["New York, NY"]);
    expect(display("  ")).toEqual([]);
  });
});

describe("locationTierOf", () => {
  const tiers = [
    { locations: ["San Francisco Bay Area", "New York City", "New Jersey", "Remote"] },
    { locations: ["Southern California", "Boston", "the rest of the East Coast"] },
  ];
  const tierOf = (raw: string) => locationTierOf(parseLocations(raw), tiers);

  it.each([
    ["San Francisco, CA", 1],
    ["Sunnyvale, CA", 1],
    ["South SF", 1],
    ["NYC", 1],
    ["Brooklyn, NY", 1],
    ["Jersey City, NJ", 1],
    ["Remote in USA", 1],
    ["Irvine, CA", 2],
    ["LA", 2],
    ["Cambridge, MA", 2],
    ["Philadelphia, PA", 2],
    ["Atlanta, GA", 2],
    ["Albany, NY", 2],
  ])("puts %s in Tier %i", (raw, tier) => {
    expect(tierOf(raw)).toBe(tier);
  });

  it.each(["Austin, TX", "Seattle, WA", "Toronto, ON, Canada", "United States", "Sacramento, CA"])(
    "leaves %s outside every Location Tier",
    (raw) => {
      expect(tierOf(raw)).toBeUndefined();
    },
  );

  it("gives a Posting the best Location Tier among its locations", () => {
    expect(tierOf("Boston, MASunnyvale, CA")).toBe(1);
    expect(tierOf("Austin, TXBoston, MA")).toBe(2);
  });

  it("matches states, cities and regions written in other ways", () => {
    const other = [
      { locations: ["Texas"] },
      { locations: ["Seattle"] },
      { locations: ["Northern California", "WA"] },
      { locations: ["Chicago, IL", "Canada", "West Coast", "United States"] },
    ];
    const tier = (raw: string) => locationTierOf(parseLocations(raw), other);
    expect(tier("Austin, TX")).toBe(1);
    expect(tier("Bellevue, WA")).toBe(2);
    expect(tier("Sacramento, CA")).toBe(3);
    expect(tier("Spokane, WA")).toBe(3);
    expect(tier("Chicago, IL")).toBe(4);
    expect(tier("Toronto, ON, Canada")).toBe(4);
    expect(tier("Portland, OR")).toBe(4);
    expect(tier("Omaha, NE")).toBe(4);
    expect(tier("London, UK")).toBeUndefined();
  });

  it("reads a plain Remote entry as remote in the US or anywhere unstated", () => {
    const tier = (raw: string, entry: string) =>
      locationTierOf(parseLocations(raw), [{ locations: [entry] }]);
    expect(tier("Remote", "Remote")).toBe(1);
    expect(tier("Remote in USA", "Remote")).toBe(1);
    expect(tier("Remote in UK", "Remote")).toBeUndefined();
    expect(tier("Remote in UK", "Remote in UK")).toBe(1);
    expect(tier("Remote in USA", "Remote in UK")).toBeUndefined();
    expect(tier("NYC", "Remote")).toBeUndefined();
  });
});

describe("unmatchedTierLocations", () => {
  it("names Location Tier entries that no Posting location matched", () => {
    const places = ["NYC", "Boston, MA"].flatMap(parseLocations);
    expect(
      unmatchedTierLocations(places, [
        { locations: ["New York City", "Gotham"] },
        { locations: ["Boston", "Remote"] },
      ]),
    ).toEqual(["Gotham", "Remote"]);
  });
});
