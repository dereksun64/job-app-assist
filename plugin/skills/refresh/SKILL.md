---
name: refresh
description: Refresh the Candidate's Job List and Queue. Pulls Postings from the Job Feed, keeps the ones that match the Search Profile, ranks them, pre-queues the best ones up to the daily Queue target, writes them to the dashboard's Postings tab and ends with a short summary in chat. Use when the Candidate asks to refresh, update their jobs, or see today's Postings.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh) Bash(rm -rf .job-app-assist/refresh/state .job-app-assist/refresh/out) Bash(mkdir -p .job-app-assist/refresh) Bash(cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html)
---

# Refresh

Refresh rebuilds the Candidate's Job List: every Posting from their Sources that matches their Search Profile, ranked best first, on the Postings tab of their dashboard.
It then tops up the Queue: the best-ranked Postings are pre-queued until the Queue holds the daily Queue target, higher Location Tiers first.
Unsubmitted Queue items carry over and count toward the target, and a Posting the Candidate skipped is never pre-queued again.
The ranking, filtering, dedupe and pre-queueing happen in `jaa refresh`, a deterministic program; your part is to hand it the dashboard state, apply what it produces, and tell the Candidate what changed.
The current working directory is the Candidate folder.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.

## 2. Find the dashboard

Read `.job-app-assist/dashboard.json`.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
If it does not exist, tell the Candidate that Refresh needs their dashboard first, ask them to run `/job-app-assist:setup`, and stop.

## 3. Bring the dashboard page up to date

Read `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
When it differs from `pageVersion`, the Toolkit has a newer dashboard page:

```bash
cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html
```

Read the dashboard `url` with the `Artifact` tool, then publish `.job-app-assist/dashboard.html` to that `url` without passing `capabilities`, so the page keeps its database and its data.
Then save `pageVersion` in `.job-app-assist/dashboard.json` as the new version.
If the publish fails, say so in the summary and carry on; the data still updates.

## 4. Save the dashboard state

Start from a clean state folder:

```bash
rm -rf .job-app-assist/refresh/state .job-app-assist/refresh/out
mkdir -p .job-app-assist/refresh
```

Read with `ArtifactData`, saving the documents as files: pass `out_dir` as the absolute path of `.job-app-assist/refresh/state` in the Candidate folder.

- `action: "get"`, `collection: "settings"`, `doc_id: "main"`.
  If there is no settings document, ask the Candidate to finish `/job-app-assist:setup` and stop.
- `action: "list"`, `collection: "postings"`.
  An empty collection is normal before the first Refresh.
- `action: "list"`, `collection: "cards"`, then `action: "list"`, `collection: "skips"`.
  These hold the Queue and the Postings the Candidate skipped; both are empty until the first Refresh or the first tick.
  Read every page of each listing, so no queued or skipped Posting is missed.

Each read reports a `version` for every document.
Use the Write tool to save `.job-app-assist/refresh/versions.json` mapping each postings document you read to its version, for example `{ "postings/meta": 4, "postings/page-1": 4 }`, or `{}` when there were none.
Cards and skips need no versions: Refresh only creates new cards and never changes a card or skip that exists.
Do not open the saved files; `jaa refresh` reads them.

## 5. Build the Job List

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh
```

It fetches the Job Feed, resolves its short links to the real application sites, filters, merges duplicates and ranks, pre-queues the best Postings as new cards, checks every document against the dashboard contract, and writes the documents and the ArtifactData batches to `.job-app-assist/refresh/out/`.
It prints the summary you will report.
If it exits with an error, nothing has been written to the dashboard: fix what the message names (usually a missing version in `versions.json`) and run it again.
A Source that fails does not stop it; the summary marks it `FAILED`, and the Postings it gave on the last Refresh are kept.

## 6. Write the Job List to the dashboard

Read `.job-app-assist/refresh/out/writes.json`.
It holds `{ "batches": [[...], ...] }`.
For each batch, in order, call `ArtifactData` with `action: "batch"`, the dashboard `url`, and that batch as `writes`, exactly as listed: every entry already carries its `file_path` and, for documents that exist, its `if_version`.

- If a batch is refused because a document changed since step 4, another Refresh is writing at the same time: go back to step 4 once.
- If the database reports it is full or over quota, stop and tell the Candidate plainly that their dashboard storage is full.

Then read `postings/meta` with `action: "get"` and check that its `refreshedAt` is the one in `.job-app-assist/refresh/out/summary.json`.

## 7. Summarize in chat

Finish with a short summary built from the `jaa refresh` output, in plain words:

- how many Postings are in the Job List, how many per Location Tier, and how many are new since the last Refresh;
- the Queue: how many Postings it holds against the daily target, how many were pre-queued now and how many carried over;
- Queue items that may have closed (queued five or more days ago, or no longer in the Job List), so the Candidate applies soon or unticks them;
- the top three to five Postings, each as company, title, location and a link to its apply URL;
- every failing Source, said plainly: which Source, what went wrong, and that today's Job List may be incomplete because of it;
- Location Tier entries that matched no Posting location, if any, with a suggestion to reword them by rerunning `/job-app-assist:setup`;
- a link to the dashboard's Postings tab (the dashboard `url` followed by `#postings`).

Keep it to a few lines; the dashboard holds the detail.
