---
name: setup
description: Set up Job App Assist. Drafts the Candidate's Search Profile from a plain-language description, saves it once they confirm, and publishes their private dashboard. Use when the Candidate wants to get started, change their Search Profile, or create their dashboard.
argument-hint: "[the jobs you want, in your own words]"
allowed-tools: Bash(node --version) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate *) Bash(mkdir -p .job-app-assist) Bash(cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html) Bash(date -u *)
---

# Setup

Setup turns the Candidate's own words into a Search Profile, saves it only after they confirm it, and gives them their private dashboard: a claude.ai Artifact in their own account with News, Postings and Progress tabs.
The current working directory is the Candidate folder; Setup's local state lives in `.job-app-assist/` inside it.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.

## 2. Find what already exists

Read `.job-app-assist/dashboard.json` if it exists.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
When it exists, this is a rerun: read the current settings with `ArtifactData` (`action: "get"`, the recorded `url`, `collection: "settings"`, `doc_id: "main"`) and start the draft from them, so the Candidate only describes what should change.
If that read finds no settings document, carry on as a first save.

## 3. Hear what the Candidate wants

The description is whatever the Candidate already said about the jobs they want, including text after `/job-app-assist:setup`.
With no description yet, ask one question: what jobs they want, in their own words (roles, level, when they can start, where).

## 4. Draft the Search Profile

Turn the description into a settings document with exactly these fields:

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

Where the description leaves a field open, choose the most likely value and mark it as an assumption when you show the draft.

## 5. Show the draft and wait for confirmation

Show the draft in plain words (role types by priority, seniority, start window, each Location Tier, daily Queue target), list your assumptions, and ask the Candidate to confirm or say what to change.
Redraft and show it again after every change.

Saving needs the Candidate's explicit confirmation of the draft as shown, given after they have seen it.
A request to save without looking ("just save it") still gets the draft shown and the question asked.
This step is complete only when the Candidate has confirmed the latest draft; until then nothing is validated, published or saved.

## 6. Check the draft against the dashboard contract

Set `updatedAt` from `date -u +%Y-%m-%dT%H:%M:%SZ`, then validate the exact JSON you will save:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate settings main - <<'JSON'
<the settings document>
JSON
```

Fix every reported problem and run it again until it prints `settings/main matches the dashboard contract.`
If a fix changes what the Candidate confirmed, show the change and confirm again.
If `node` is missing or older than version 20 (`node --version`), tell the Candidate to install Node.js 20 or newer from https://nodejs.org and run Setup again, and stop here.

## 7. Publish the dashboard

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

## 8. Save the settings document

Write the validated document with `ArtifactData`: `action: "set"`, the dashboard `url`, `collection: "settings"`, `doc_id: "main"`, and the document as `data`.
When step 2 found an existing settings document, pass its `version` as `if_version`.
Read it back with `action: "get"`; Setup is done when the stored document matches what the Candidate confirmed.

## 9. Hand over

Give the Candidate the dashboard link and a one-line summary of the saved Search Profile.
Tell them the Search Profile appears at the top of the dashboard, and that News, Postings and Progress fill in once they refresh.
