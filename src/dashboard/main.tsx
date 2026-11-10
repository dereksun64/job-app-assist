/**
 * Boots the dashboard inside the claude.ai Artifact viewer. The page renders at once and
 * lights up when the `db` capability resolves; it uses no other capability (ADR 0002).
 */
import { render } from "preact";
import { App } from "./App.tsx";
import type { DashboardDb } from "./db.ts";

declare const __PAGE_VERSION__: string;

interface ArtifactRuntime {
  use(name: "db"): Promise<DashboardDb | null>;
}

const root = document.getElementById("app");
if (!root) throw new Error("The dashboard page is missing its #app element.");

const draw = (db: DashboardDb | null | undefined) => {
  render(<App db={db} pageVersion={__PAGE_VERSION__} />, root);
};

draw(undefined);

const runtime = (window as { claude?: ArtifactRuntime }).claude;
(runtime ? runtime.use("db") : Promise.resolve(null)).then(
  (db) => {
    draw(db ?? null);
  },
  () => {
    draw(null);
  },
);
