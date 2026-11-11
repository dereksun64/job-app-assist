/**
 * `jaa prerequisites`: the part of Setup's prerequisite check that reads this computer. Fill runs
 * in the Helium browser through the Claude extension (Claude in Chrome) with Simplify Copilot, so
 * this looks for Helium in the Applications folders and for both extensions in Helium's profiles,
 * on disk, and says how to fix whatever is missing. Whether the Claude extension is connected to
 * this session, and whether Gmail is, only the skill can see from its tools.
 */
import { join } from "node:path";

export interface PrerequisitesIo {
  readFile(path: string): Promise<string>;
  /** The names in a directory, or none when it does not exist. */
  readDir(path: string): Promise<string[]>;
  homeDir(): string;
  /** `process.platform`. */
  platform(): string;
  /** `process.versions.node`. */
  nodeVersion(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The Claude extension (Claude in Chrome) in the Chrome Web Store. */
export const CLAUDE_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
/** Simplify Copilot in the Chrome Web Store. */
export const SIMPLIFY_EXTENSION_ID = "pbanhockgagggenencehbnadejlgchfc";

const MIN_NODE = 20;
const HELIUM_DATA = ["Library", "Application Support", "net.imput.helium"];
const CHROME_DATA = ["Library", "Application Support", "Google", "Chrome"];
const webStore = (id: string) => `https://chromewebstore.google.com/detail/${id}`;

type ExtensionState = "on" | "off" | "missing";

async function readJson(io: PrerequisitesIo, path: string): Promise<unknown> {
  try {
    return JSON.parse(await io.readFile(path)) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function heliumInstalled(io: PrerequisitesIo): Promise<boolean> {
  for (const apps of ["/Applications", join(io.homeDir(), "Applications")]) {
    if ((await io.readDir(join(apps, "Helium.app"))).length > 0) return true;
  }
  return false;
}

/** Helium's profile folders, from its Local State; Default when it lists none. */
async function profiles(io: PrerequisitesIo, data: string): Promise<string[]> {
  const state = await readJson(io, join(data, "Local State"));
  const cache = isObject(state) && isObject(state.profile) ? state.profile.info_cache : undefined;
  const names = isObject(cache) ? Object.keys(cache) : [];
  return names.length > 0 ? names : ["Default"];
}

function turnedOff(entry: Record<string, unknown>): boolean {
  const reasons = entry.disable_reasons;
  if (Array.isArray(reasons) && reasons.length > 0) return true;
  if (typeof reasons === "number" && reasons !== 0) return true;
  return entry.state === 0;
}

/** Whether an extension is installed in any of a browser's profiles, and whether it is on there. */
async function extension(
  io: PrerequisitesIo,
  id: string,
  browser: readonly string[] = HELIUM_DATA,
): Promise<ExtensionState> {
  const data = join(io.homeDir(), ...browser);
  let found: ExtensionState = "missing";
  for (const profile of await profiles(io, data)) {
    const folder = join(data, profile);
    if ((await io.readDir(join(folder, "Extensions", id))).length === 0) continue;
    for (const file of ["Secure Preferences", "Preferences"]) {
      const prefs = await readJson(io, join(folder, file));
      const settings =
        isObject(prefs) && isObject(prefs.extensions) ? prefs.extensions.settings : undefined;
      const entry = isObject(settings) ? settings[id] : undefined;
      if (!isObject(entry)) continue;
      if (!turnedOff(entry)) return "on";
      found = "off";
    }
  }
  return found;
}

function extensionLine(name: string, state: ExtensionState, install: string): string {
  if (state === "on") return `${name} in Helium: installed and on.`;
  if (state === "off") {
    return `${name} in Helium: installed but turned off. Fix: in Helium, open the puzzle-piece menu, choose Manage extensions, and turn ${name} on.`;
  }
  return `${name} in Helium: missing. Fix: ${install}`;
}

/** Prints the checklist; exits 1 only when Node.js is too old for the Toolkit to run. */
export async function runPrerequisites(io: PrerequisitesIo): Promise<number> {
  const lines: string[] = [];
  const node = io.nodeVersion();
  const nodeOk = (Number.parseInt(node, 10) || 0) >= MIN_NODE;
  lines.push(
    nodeOk
      ? `Node.js ${node}: ready.`
      : `Node.js ${node}: too old. Fix: install Node.js ${String(MIN_NODE)} or newer from https://nodejs.org, then run Setup again.`,
  );

  if (io.platform() !== "darwin") {
    lines.push(
      "Fill works only on a Mac, in the Helium browser. Setup, Refresh, Tune and the dashboard work here; fill applications from a Mac.",
    );
  } else {
    lines.push(
      (await heliumInstalled(io))
        ? "Helium: installed."
        : "Helium: missing. Fix: download Helium from https://helium.computer, move it to Applications, and open it once.",
    );
    lines.push(
      extensionLine(
        "Claude extension",
        await extension(io, CLAUDE_EXTENSION_ID),
        `in Helium, open ${webStore(CLAUDE_EXTENSION_ID)}, choose Add to Chrome, then open the extension and sign in with the claude.ai account this Claude uses.`,
      ),
    );
    if ((await extension(io, CLAUDE_EXTENSION_ID, CHROME_DATA)) === "on") {
      lines.push(
        "The Claude extension is also on in Google Chrome. Fill must run in Helium: when both browsers are open, Claude may connect to Chrome instead, so quit Chrome before filling, or turn the Claude extension off there.",
      );
    }
    lines.push(
      extensionLine(
        "Simplify Copilot",
        await extension(io, SIMPLIFY_EXTENSION_ID),
        `in Helium, open ${webStore(SIMPLIFY_EXTENSION_ID)}, choose Add to Chrome, then sign in to Simplify and fill in your Simplify profile (education, work history, links).`,
      ),
    );
  }
  lines.push(
    "Still to check in this session: that the Claude extension is connected to Claude, and, for Gmail tracking, that the Gmail connector is connected.",
  );
  io.stdout(`${lines.join("\n")}\n`);
  return nodeOk ? 0 : 1;
}
