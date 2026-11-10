---
name: refresh
description: Refresh the Candidate's Job List and Queue. Pulls Postings from the Job Feed, keeps the ones that match the Search Profile, ranks them, picks a Resume Variant for each, pre-queues the best ones up to the daily Queue target, writes them to the dashboard's Postings tab and ends with a short summary in chat. Use when the Candidate asks to refresh, update their jobs, or see today's Postings.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh --rerun) Bash(rm -rf .job-app-assist/refresh/state .job-app-assist/refresh/out) Bash(mkdir -p .job-app-assist/refresh) Bash(cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html)
---

# Refresh

Refresh rebuilds the Candidate's Job List: every Posting from their Sources that matches their Search Profile, ranked best first, on the Postings tab of their dashboard.
It then tops up the Queue: the best-ranked Postings are pre-queued until the Queue holds the daily Queue target, higher Location Tiers first.
Unsubmitted Queue items carry over and count toward the target, and a Posting the Candidate skipped is never pre-queued again.
The ranking, filtering, dedupe, Resume Variant picks and pre-queueing happen in `jaa refresh`, a deterministic program; your part is to hand it the dashboard state, review the picks it is unsure about, apply what it produces, and tell the Candidate what changed.
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

It fetches the Job Feed, resolves its short links to the real application sites, filters, merges duplicates, ranks, picks a Resume Variant for every Posting, pre-queues the best Postings as new cards, checks every document against the dashboard contract, and writes the documents and the ArtifactData batches to `.job-app-assist/refresh/out/`.
It prints the summary you will report.
If it exits with an error, nothing has been written to the dashboard: fix what the message names (usually a missing version in `versions.json`) and run it again.
If it says the settings document does not match the dashboard contract (for example, it has no `resumeVariants`), ask the Candidate to run `/job-app-assist:setup` again to bring their settings up to date, and stop.
A Source that fails does not stop it; the summary marks it `FAILED`, and the Postings it gave on the last Refresh are kept.

## 6. Review unsure Resume Variant picks

Each Posting's Resume Variant comes from the rules Setup recorded: the role types each variant is made for and the keywords that point to it.
When the summary reports unsure picks, read `.job-app-assist/refresh/out/variant-review.json`.
It holds the Candidate's `variants` with their rules, `unsure` (how many picks were unsure), and `postings`: the best-ranked unsure ones, each with its `id`, company, title, role type, apply URL, the variant `picked` and the `reason`.

For each listed Posting, decide which Resume Variant fits it best, judging from its title, company and role type against each variant's label and rules.
Keep the pick when it is already the best fit, and change it when another variant clearly fits better.
Do not open the Postings' sites for this; when the title says too little to tell, keep the pick.

Record every decision, kept or changed, so the next Refresh does not ask again.
Read `.job-app-assist/refresh/variant-judgments.json` if it exists, add one entry per reviewed Posting, and save the whole file with the Write tool:

```json
{
  "<Posting id>": {
    "variant": "<Resume Variant name, exactly as listed>",
    "reason": "<one plain sentence about this Posting>"
  }
}
```

Write the reason for the Candidate, who sees it in the dashboard's detail drawer after "Reviewed:", for example "The role is on the search ranking team, which fits the AI/ML resume." (280 characters at most).
Then rebuild without the network, which applies the decisions:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh --rerun
```

Use the summary it prints from here on.
Unsure picks beyond the listed ones keep their pick and come up again on a later Refresh.

## 7. Write the Job List to the dashboard

Read `.job-app-assist/refresh/out/writes.json`.
It holds `{ "batches": [[...], ...] }`.
For each batch, in order, call `ArtifactData` with `action: "batch"`, the dashboard `url`, and that batch as `writes`, exactly as listed: every entry already carries its `file_path` and, for documents that exist, its `if_version`.

- If a batch is refused because a document changed since step 4, another Refresh is writing at the same time: go back to step 4 once.
- If the database reports it is full or over quota, stop and tell the Candidate plainly that their dashboard storage is full.

Then read `postings/meta` with `action: "get"` and check that its `refreshedAt` is the one in `.job-app-assist/refresh/out/summary.json`.

## 8. Summarize in chat

Finish with a short summary built from the `jaa refresh` output, in plain words:

- how many Postings are in the Job List, how many per Location Tier, and how many are new since the last Refresh;
- the Queue: how many Postings it holds against the daily target, how many were pre-queued now and how many carried over;
- Queue items that may have closed (queued five or more days ago, or no longer in the Job List), so the Candidate applies soon or unticks them;
- how many Postings got each Resume Variant, how many unsure picks you reviewed and how many you changed, and that the Candidate can change any Posting's Resume Variant in its detail drawer;
- the top three to five Postings, each as company, title, location and a link to its apply URL;
- every failing Source, said plainly: which Source, what went wrong, and that today's Job List may be incomplete because of it;
- Location Tier entries that matched no Posting location, if any, with a suggestion to reword them by rerunning `/job-app-assist:setup`;
- a link to the dashboard's Postings tab (the dashboard `url` followed by `#postings`).

Keep it to a few lines; the dashboard holds the detail.
