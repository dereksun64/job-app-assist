import { describe, expect, it } from "vitest";
import { parseConnectionsExport, readConnectionsFile } from "./connections.ts";

/** A connections export as LinkedIn writes it: a notes preamble, then the table. */
const EXPORT = [
  "\uFEFFNotes:",
  '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed it, see https://www.linkedin.com/psettings/privacy/email"',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Priya,Shah,https://www.linkedin.com/in/priya-shah,priya@example.com,Datadog,Senior Software Engineer,08 Nov 2024",
  'Sam,Lee,https://www.linkedin.com/in/sam-lee,,"Stripe, Inc.","Recruiter, University",15 Mar 2023',
  '"Ana ""AJ""",Neil,https://www.linkedin.com/in/ana,,Acme,,01 Jan 2020',
  "Jo,Park,https://www.linkedin.com/in/jo,,,Student,02 Feb 2022",
  ",,https://www.linkedin.com/in/hidden,,Datadog,,03 Mar 2021",
].join("\r\n");

describe("parseConnectionsExport", () => {
  it("keeps each connection's name, company, position and date, and nothing else", () => {
    expect(parseConnectionsExport(EXPORT)).toEqual({
      ok: true,
      connections: [
        {
          name: "Priya Shah",
          company: "Datadog",
          position: "Senior Software Engineer",
          connectedOn: "2024-11-08",
        },
        {
          name: "Sam Lee",
          company: "Stripe, Inc.",
          position: "Recruiter, University",
          connectedOn: "2023-03-15",
        },
        { name: 'Ana "AJ" Neil', company: "Acme", connectedOn: "2020-01-01" },
      ],
      leftOut: 2,
    });
  });

  it("reads an export with no preamble and a date it does not know", () => {
    const csv =
      "First Name,Last Name,Company,Position,Connected On\nPriya,Shah,Datadog,SWE,someday\n";
    expect(parseConnectionsExport(csv)).toEqual({
      ok: true,
      connections: [{ name: "Priya Shah", company: "Datadog", position: "SWE" }],
      leftOut: 0,
    });
  });

  it("explains a file that is not a connections export", () => {
    expect(parseConnectionsExport("Name,Email\nPriya,priya@example.com\n")).toEqual({
      ok: false,
      error:
        'This is not a LinkedIn connections export: it has no row of column names with "First Name", "Last Name" and "Company". Use Connections.csv from the LinkedIn data export.',
    });
  });

  it("explains an export with no connections in it", () => {
    expect(
      parseConnectionsExport(
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n",
      ),
    ).toEqual({ ok: false, error: "The connections export lists no connections." });
  });
});

describe("readConnectionsFile", () => {
  it("reads the Candidate's imported connections", () => {
    const file = {
      schemaVersion: 1,
      importedAt: "2026-11-10T15:00:00.000Z",
      connections: [{ name: "Priya Shah", company: "Datadog", connectedOn: "2024-11-08" }],
    };
    expect(readConnectionsFile(file)).toEqual({ ok: true, value: file });
  });

  it("rejects a file in another shape", () => {
    expect(readConnectionsFile({ connections: "Priya" }).ok).toBe(false);
  });
});
