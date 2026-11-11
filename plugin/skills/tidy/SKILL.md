---
name: tidy
description: Make room in the Candidate's dashboard when its storage is full. Lists the old history it can remove (Closed cards that closed 30 or more days ago with their answers, Referral Drafts and Resume Variant choices, leftovers with no card, skips older than 180 days and News Digests older than 90 days), removes it only after the Candidate approves, and never touches open cards, settings, Sources or the Job List. Use when the dashboard says its storage is full, a dashboard write fails with quota_exceeded, or the Candidate asks to tidy, clean up or make room in their dashboard.
argument-hint: "[how many days a Closed card stays before it goes, if not 30]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs tidy plan .job-app-assist/tidy) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs tidy plan .job-app-assist/tidy --closed-days *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs tidy build .job-app-assist/tidy) Bash(rm -rf .job-app-assist/tidy) Bash(mkdir -p .job-app-assist/tidy) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard check .job-app-assist) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard record .job-app-assist *)
---

# Tidy

A dashboard database holds at most 25,000 documents and a limited total size.
The Job List, News Digests and Referral Drafts stay bounded on their own, but every Posting the Candidate ever queued keeps a card and usually a Prepared Application, and every Posting they unticked keeps a skip.
Tidy removes the history the Candidate no longer acts on, and only after they approve the exact list.
`jaa tidy` decides what can go and builds the removals; your part is reading the dashboard, showing the list and sending what the Candidate approved.
The current working directory is the Candidate folder.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.

## 2. Find the dashboard

Read `.job-app-assist/dashboard.json`.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
If it does not exist, tell the Candidate there is no dashboard to tidy, point them to `/job-app-assist:setup`, and stop.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard check .job-app-assist
```

When it says the Toolkit has a newer dashboard page, read the dashboard `url` with the `Artifact` tool, then publish `.job-app-assist/dashboard.html` to that `url` without passing `capabilities`, so the page keeps its database and its data, and run the `jaa dashboard record` command it printed.
If the publish fails, say so at the end and carry on.

## 3. Save the dashboard state

```bash
rm -rf .job-app-assist/tidy
mkdir -p .job-app-assist/tidy
```

Read with `ArtifactData`, the dashboard `url`, and `out_dir` set to the absolute path of `.job-app-assist/tidy/state` in the Candidate folder, reading every page of each listing:

- `action: "get"`, `collection: "settings"`, `doc_id: "main"`.
- `action: "list"` of each of these collections: `sources`, `postings`, `cards`, `skips`, `news`, `referrals`, `applications` and `variantOverrides`.

Each read reports a `version` for every document; keep them, since step 5 needs the versions of the documents Tidy removes.
Do not open the saved files; `jaa tidy` reads them.

## 4. Plan, and ask the Candidate

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs tidy plan .job-app-assist/tidy
```

A Closed card goes once it has been Closed for 30 days.
When the Candidate asked for a different wait (including text after `/job-app-assist:tidy`, such as "everything closed" for 0 days or "older than a week" for 7), add `--closed-days <days>`.

It prints how many documents the dashboard holds, how many Tidy would remove, and what they are: each Closed card by company and title, then counts of leftovers, old skips and old News Digests.
Show that list to the Candidate in plain words and ask whether to remove it.
Removing cannot be undone: a removed card leaves the Progress board for good, with its answers and Referral Drafts.
Say that open cards, settings, Sources and the Job List all stay.

Remove nothing until the Candidate approves this exact list, after seeing it.
When they want to keep some cards, run the plan again with a longer `--closed-days`, or tell them to move a card they want to keep out of Closed on the Progress board first, then plan again.

When it says there is nothing to remove, tell the Candidate what it suggests and stop.

## 5. Build the removals

Use the Write tool to save `.job-app-assist/tidy/versions.json`, mapping each document in `.job-app-assist/tidy/out/tidy-plan.json` to the version step 3 reported for it, for example `{ "cards/0123456789ab": 3, "applications/0123456789ab": 2 }`.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs tidy build .job-app-assist/tidy
```

If it names documents with no version, add them and run it again.

## 6. Remove

Read `.job-app-assist/tidy/out/writes.json`.
It holds `{ "batches": [[...], ...] }`.
For each batch, in order, call `ArtifactData` with `action: "batch"`, the dashboard `url`, and that batch as `writes`, exactly as listed.
If a batch is refused because a document changed since step 3, the Candidate changed it meanwhile: stop, go back to step 3 once, and show the new list before removing anything more.

## 7. Summarize

Tell the Candidate how many documents were removed and how many the dashboard holds now, and that they can ask again for whatever stopped when the storage was full (a Refresh, a Fill, or a change on the dashboard).
