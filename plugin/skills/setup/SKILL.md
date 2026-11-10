---
name: setup
description: Set up Job App Assist. Drafts the Candidate's Search Profile from a plain-language description, records their labeled Resume Variants, saves both once they confirm, publishes their private dashboard, and optionally imports their LinkedIn connections export for Referral Drafts. Use when the Candidate wants to get started, change their Search Profile, add or change their resumes, create their dashboard, or import their LinkedIn connections.
argument-hint: "[the jobs you want, in your own words]"
allowed-tools: Bash(node --version) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs check-resumes *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs import-connections *) Bash(mkdir -p .job-app-assist) Bash(cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html) Bash(date -u *)
---

# Setup

Setup turns the Candidate's own words into a Search Profile, records their Resume Variants, saves both only after they confirm them, and gives them their private dashboard: a claude.ai Artifact in their own account with News, Postings and Progress tabs.
It can also import the Candidate's LinkedIn connections, so each Refresh can suggest Referral Drafts.
The current working directory is the Candidate folder; Setup's local state lives in `.job-app-assist/` inside it.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.

## 2. Find what already exists

Read `.job-app-assist/dashboard.json` if it exists.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
When it exists, this is a rerun: read the current settings with `ArtifactData` (`action: "get"`, the recorded `url`, `collection: "settings"`, `doc_id: "main"`) and start the draft from them, so the Candidate only describes what should change.
If that read finds no settings document, carry on as a first save.
Also read `.job-app-assist/resume-variants.json` if it exists: it lists the Resume Variants recorded last time.
Note whether `.job-app-assist/connections.json` exists: it means the Candidate imported their connections before.

When the Candidate only asks to import their LinkedIn connections and the dashboard already exists, go straight to step 11.

## 3. Hear what the Candidate wants

The description is whatever the Candidate already said about the jobs they want, including text after `/job-app-assist:setup`.
With no description yet, ask one question: what jobs they want, in their own words (roles, level, when they can start, where).

## 4. Draft the Search Profile

Turn the description into a settings document with exactly these fields, plus the `resumeVariants` that step 5 adds:

```json
{
  "schemaVersion": 1,
  "searchProfile": {
    "roleTypes": [{ "name": "Software Engineer", "priority": "high" }],
    "seniority": ["new_grad"],
    "startWindow": { "earliest": "2027-01", "latest": "2027-12" },
    "locationTiers": [{ "locations": ["New York City", "Remote"] }, { "locations": ["Boston"] }]
  },
  "dailyQueueTarget": 20,
  "companies": { "boost": [], "lower": [], "block": [] },
  "blockedApplySites": [],
  "freshnessWeight": 20,
  "updatedAt": "<now, ISO 8601 UTC>"
}
```

- `roleTypes`: one entry per role type the Candidate named, written the way job titles usually say it (Software Engineer, Machine Learning Engineer).
  `priority` is `high` for the roles they call their focus, `medium` for others they want, and `low` for fallbacks and "also open to" roles.
- `seniority`: every level the Candidate would accept, from `intern`, `new_grad` and `junior`.
- `startWindow`: months as `YYYY-MM`; leave out `earliest` or `latest` when the Candidate gave no bound ("any time in 2027" is `2027-01` to `2027-12`).
- `locationTiers`: Tier 1 first.
  Places the Candidate prefers go in Tier 1, places they would accept go in later tiers, and each location appears in only one tier.
  Remote is a location like any other.
- `dailyQueueTarget`: how many Postings to queue per day, 1 to 100.
  The default is 20; a smaller Claude plan suits a smaller number.

- `companies`, `blockedApplySites` and `freshnessWeight`: start empty and at 20 unless the Candidate names companies to prefer, avoid or rule out, application sites to avoid, or how much recency matters.
  On a rerun, keep what the current settings have; the Candidate tunes these later with `/job-app-assist:tune` or the dashboard's Settings panel.

Where the description leaves a field open, choose the most likely value and mark it as an assumption when you show the draft.

## 5. Record the Resume Variants

A Resume Variant is one of the Candidate's own hand-written resumes, aimed at a role type.
Refresh picks one for every Posting and Fill uploads it; the Toolkit never edits a resume.

Ask the Candidate for each resume they want to use: where the file is in the Candidate folder (a PDF or Word file) and a short label for it, such as "Backend SWE/SDE".
One resume is enough to start; they can add more later by running Setup again.
If a file is outside the Candidate folder, ask them to copy it in (a `resumes/` folder works well) and wait until they have.
On a rerun, start from the Resume Variants already recorded and ask only what should change.

Use the Write tool to save `.job-app-assist/resume-variants.json`, listing the most general resume first:

```json
{
  "variants": [
    { "name": "Generalist SWE", "file": "resumes/generalist.pdf" },
    { "name": "AI/ML Engineer", "file": "resumes/ml.pdf" }
  ]
}
```

Then check the files are where the manifest says:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs check-resumes .job-app-assist/resume-variants.json
```

Fix every reported problem with the Candidate and run it again until it prints that every file was found.
If `node` is missing or older than version 20 (`node --version`), tell the Candidate to install Node.js 20 or newer from https://nodejs.org and run Setup again, and stop here.

Add the Resume Variants to the settings draft as `resumeVariants`, with the same names in the same order:

```json
"resumeVariants": [
  { "name": "Generalist SWE", "roleTypes": ["Software Engineer"], "keywords": ["full stack", "generalist"] },
  { "name": "AI/ML Engineer", "roleTypes": ["Machine Learning Engineer"], "keywords": ["machine learning", "ML", "AI", "LLM"] }
]
```

- The first Resume Variant is the default: Refresh uses it when nothing points to another one, so it should be the most general resume.
- `roleTypes`: the Search Profile role types the resume is written for, spelled exactly as in `searchProfile.roleTypes`; leave it empty when none fits.
- `keywords`: 3 to 10 words or phrases that, in a Posting's title or description, mean this resume fits best (for a backend resume: backend, distributed systems, infrastructure, API).
  Draft them from the label, the role types and what the Candidate says the resume emphasizes; you may read a resume file to suggest them.
- With a single Resume Variant, Refresh always picks it, so its rules can stay empty.

The files themselves never go to the dashboard: it holds only each Resume Variant's name and rules, and the manifest that pairs names with files stays in the Candidate folder.

## 6. Show the draft and wait for confirmation

Show the draft in plain words (role types by priority, seniority, start window, each Location Tier, daily Queue target, and each Resume Variant with its file, role types and keywords, the default first), list your assumptions, and ask the Candidate to confirm or say what to change.
Redraft and show it again after every change.

Saving needs the Candidate's explicit confirmation of the draft as shown, given after they have seen it.
A request to save without looking ("just save it") still gets the draft shown and the question asked.
This step is complete only when the Candidate has confirmed the latest draft; until then nothing is validated, published or saved to the dashboard.

## 7. Check the draft against the dashboard contract

Set `updatedAt` from `date -u +%Y-%m-%dT%H:%M:%SZ`, then validate the exact JSON you will save:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate settings main - <<'JSON'
<the settings document>
JSON
```

Fix every reported problem and run it again until it prints `settings/main matches the dashboard contract.`
Then confirm the settings name the same Resume Variants as the files:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs check-resumes .job-app-assist/resume-variants.json --settings - <<'JSON'
<the settings document>
JSON
```

If a fix changes what the Candidate confirmed, show the change and confirm again.

## 8. Publish the dashboard

Copy the page into the Candidate folder, since the Artifact tool publishes files from there:

```bash
mkdir -p .job-app-assist
cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html
```

Publish `.job-app-assist/dashboard.html` with the `Artifact` tool and these capabilities, so only the Candidate can read or write the dashboard data even if the page is ever shared:

```json
{ "db": { "rules": [{ "path": "", "read": "owner", "write": "owner" }] } }
```

- First run: publish with `icon: "briefcase"` and `description: "Your Job App Assist dashboard: News, Postings and Progress."`.
- Rerun: read the recorded `url` with the Artifact tool, then publish to that `url`, so the page updates in place and its data stays.

Then use the Write tool to save `.job-app-assist/dashboard.json` with the dashboard `url` and `pageVersion` set to the `version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.

If the Artifact tool is not available, tell the Candidate that their dashboard needs Claude Code signed in with a claude.ai account and stop; their Search Profile is not saved yet.

## 9. Save the settings document

Write the validated document with `ArtifactData`: `action: "set"`, the dashboard `url`, `collection: "settings"`, `doc_id: "main"`, and the document as `data`.
When step 2 found an existing settings document, pass its `version` as `if_version`.
Read it back with `action: "get"`; Setup is done when the stored document matches what the Candidate confirmed.

## 10. Seed the Sources

List the `sources` collection with `ArtifactData` (`action: "list"`, the dashboard `url`).
For each of these documents that is missing, write it with `action: "set"`, after checking it with `node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate sources <doc-id> -` as in step 7, and with `updatedAt` from the same `date -u` command:

- `job-feed`: `{ "schemaVersion": 1, "enabled": true, "updatedAt": "<now>" }`
- `watchlist`: `{ "schemaVersion": 1, "enabled": true, "companies": [], "updatedAt": "<now>" }`
- `added-by-url`: `{ "schemaVersion": 1, "enabled": true, "postings": [], "updatedAt": "<now>" }`

Never overwrite a Source document that exists: the Candidate's switches, watchlist and added Postings live there.

## 11. Offer to import LinkedIn connections

This step is optional.
With the Candidate's LinkedIn connections in the Candidate folder, each Refresh drafts a short referral ask for connections who work at the companies in their Queue, and shows each one in that Posting's drawer with a copy button.
The Candidate sends every message themselves.

Ask once whether they want Referral Drafts.
On a rerun where `.job-app-assist/connections.json` exists, ask instead whether they have a newer export to import, since people change jobs.
A no is fine: skip to step 12.

The Candidate gets the export from LinkedIn themselves; never open LinkedIn for them (hard rule 3).
Tell them how:

1. On LinkedIn, open **Me**, then **Settings & Privacy**, then **Data privacy**, then **Get a copy of your data**.
2. Choose **Connections** only, and request the archive.
3. LinkedIn emails a download link, usually within half an hour.
   Download the archive, unzip it, and say where `Connections.csv` is (dragging the file into the chat works).

When they give the path, import it:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs import-connections "<path to Connections.csv>" .job-app-assist/connections.json
```

The export may sit outside the Candidate folder (in Downloads, say); the import only reads it.
It keeps each connection's name, company, position and the date they connected, and leaves out email addresses and profile links.
If it reports a problem, tell the Candidate what it says (usually that the file is not the connections export) and wait for the right file.

When it succeeds, tell the Candidate how many connections it imported, that the file stays on this computer and never goes to the dashboard, and that they may delete the download.
Do not open `.job-app-assist/connections.json` or repeat its contents in chat; Refresh reads it.
To stop Referral Drafts later, the Candidate deletes `.job-app-assist/connections.json`.

## 12. Hand over

Give the Candidate the dashboard link and a one-line summary of the saved Search Profile and Resume Variants, and whether Referral Drafts are on.
Tell them the Search Profile appears at the top of the dashboard, and that News, Postings and Progress fill in once they refresh.
Mention the Sources button beside the tabs, where they can switch Sources on or off, follow companies on a watchlist, and add Postings by URL.
