/**
 * `jaa import-connections <export.csv> <out.json>`: Setup's optional import of the Candidate's
 * LinkedIn connections export. It reads the file the Candidate downloaded from LinkedIn and saves
 * only what Referral Drafts need into the Candidate folder. Nothing here touches LinkedIn or the
 * dashboard database.
 */
import { companyKey } from "../engine/companies.ts";
import { parseConnectionsExport, type ConnectionsFile } from "../refresh/connections.ts";

export interface ConnectionsIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  now(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export async function runImportConnections(
  exportPath: string,
  outPath: string,
  io: ConnectionsIo,
): Promise<number> {
  let csv: string;
  try {
    csv = await io.readFile(exportPath);
  } catch (error) {
    io.stderr(
      `Could not read ${exportPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const parsed = parseConnectionsExport(csv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 1;
  }
  const file: ConnectionsFile = {
    schemaVersion: 1,
    importedAt: io.now(),
    connections: parsed.connections,
  };
  await io.writeFile(outPath, `${JSON.stringify(file, null, 2)}\n`);
  const companies = new Set(parsed.connections.map((c) => companyKey(c.company))).size;
  const leftOut =
    parsed.leftOut === 0
      ? ""
      : ` ${count(parsed.leftOut, "connection with no company listed was", "connections with no company listed were")} left out.`;
  io.stdout(
    `Imported ${count(parsed.connections.length, "connection")} at ${count(companies, "company", "companies")} into ${outPath}.${leftOut}\n` +
      "Email addresses and profile links were not kept. The file stays on this computer; " +
      "the dashboard only ever holds the Referral Drafts made from it.\n",
  );
  return 0;
}
