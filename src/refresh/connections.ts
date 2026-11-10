/**
 * The Candidate's LinkedIn connections, imported once by Setup from the connections export
 * (Connections.csv in LinkedIn's data export) into `.job-app-assist/connections.json` in the
 * Candidate folder. Only each connection's name, company, position and date connected are kept:
 * email addresses and profile URLs are dropped on import. The file never goes to the dashboard
 * database; Refresh reads it to match connections to the companies in the Queue.
 */
import * as z from "zod/mini";
import { validateWith, type Validation } from "../contract/validation.ts";
import type { Connection } from "../engine/referrals.ts";

export const CONNECTIONS_FILE = "connections.json";

const text = (max: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max));

const connectionsFile = z.strictObject({
  schemaVersion: z.literal(1),
  importedAt: z.iso.datetime(),
  connections: z.array(
    z.strictObject({
      name: text(100),
      company: text(100),
      position: z.optional(text(150)),
      connectedOn: z.optional(z.iso.date()),
    }),
  ),
});

export type ConnectionsFile = z.output<typeof connectionsFile>;

export function readConnectionsFile(input: unknown): Validation<ConnectionsFile> {
  return validateWith(connectionsFile, input);
}

export type ParsedExport =
  { ok: true; connections: Connection[]; leftOut: number } | { ok: false; error: string };

/** Splits CSV text into rows of fields, following RFC 4180 quoting. */
function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text.charAt(i + 1) === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** LinkedIn's "08 Nov 2024" as "2024-11-08", or undefined for any other form. */
function isoDate(value: string): string | undefined {
  const match = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/.exec(value.trim());
  if (!match) return undefined;
  const [, day = "", month = "", year = ""] = match;
  const index = MONTHS.indexOf(month.toLowerCase());
  if (index < 0) return undefined;
  const date = `${year}-${String(index + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(date)) ? undefined : date;
}

const clean = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** Reads a LinkedIn connections export, keeping only what Referral Drafts need. */
export function parseConnectionsExport(csv: string): ParsedExport {
  const rows = csvRows(csv);
  const headerAt = rows.findIndex((row) => {
    const names = row.map((cell) => clean(cell).toLowerCase());
    return ["first name", "last name", "company"].every((name) => names.includes(name));
  });
  const header = rows[headerAt];
  if (!header) {
    return {
      ok: false,
      error:
        'This is not a LinkedIn connections export: it has no row of column names with "First Name", "Last Name" and "Company". Use Connections.csv from the LinkedIn data export.',
    };
  }
  const column = (name: string) => header.findIndex((cell) => clean(cell).toLowerCase() === name);
  const first = column("first name");
  const last = column("last name");
  const company = column("company");
  const position = column("position");
  const connectedOn = column("connected on");

  const connections: Connection[] = [];
  let leftOut = 0;
  let listed = 0;
  for (const row of rows.slice(headerAt + 1)) {
    if (row.every((cell) => clean(cell) === "")) continue;
    listed++;
    const name = clean(`${row[first] ?? ""} ${row[last] ?? ""}`).slice(0, 100);
    const employer = clean(row[company]).slice(0, 100);
    // A connection with a hidden name or no company cannot be matched to a Posting.
    if (name === "" || employer === "") {
      leftOut++;
      continue;
    }
    const connection: Connection = { name, company: employer };
    const role = position < 0 ? "" : clean(row[position]).slice(0, 150);
    if (role !== "") connection.position = role;
    const date = connectedOn < 0 ? undefined : isoDate(row[connectedOn] ?? "");
    if (date !== undefined) connection.connectedOn = date;
    connections.push(connection);
  }
  if (listed === 0) return { ok: false, error: "The connections export lists no connections." };
  return { ok: true, connections, leftOut };
}
