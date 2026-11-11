---
name: setup
description: Set up Job App Assist. Drafts the Candidate's Search Profile from a plain-language description, records their labeled Resume Variants, asks whether Refresh may read their Gmail to track applications, saves it all once they confirm, publishes their private dashboard, optionally imports their LinkedIn connections export for Referral Drafts, creates the private file of sensitive answers Fill uses, and writes the Style Guide every AI-drafted answer follows. Use when the Candidate wants to get started, change their Search Profile, add or change their resumes, switch Gmail tracking on or off, create their dashboard, import their LinkedIn connections, set up their private answers, or change how their drafted answers sound.
argument-hint: "[the jobs you want, in your own words]"
allowed-tools: Bash(node --version) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs check-resumes *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs import-connections *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs private-answers init private-answers.md) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs private-answers check private-answers.md) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs style-guide init style-guide.md) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs style-guide check style-guide.md) Bash(mkdir -p .job-app-assist) Bash(cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html) Bash(date -u *)
---

# Setup

Setup turns the Candidate's own words into a Search Profile, records their Resume Variants, asks whether Refresh may read their Gmail, saves it all only after they confirm it, and gives them their private dashboard: a claude.ai Artifact in their own account with News, Postings and Progress tabs.
It can also import the Candidate's LinkedIn connections, so each Refresh can suggest Referral Drafts.
Last, it creates the private file of sensitive answers that Fill reads, and the Style Guide every AI-drafted answer follows; both stay in the Candidate folder.
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

When the Candidate only asks to import their LinkedIn connections and the dashboard already exists, go straight to step 12.
When they only ask to change how their drafted answers sound, go straight to step 14.

## 3. Hear what the Candidate wants

The description is whatever the Candidate already said about the jobs they want, including text after `/job-app-assist:setup`.
With no description yet, ask one question: what jobs they want, in their own words (roles, level, when they can start, where).

## 4. Draft the Search Profile

Turn the description into a settings document with exactly these fields, plus the `resumeVariants` that step 5 adds and the `gmailTracking` that step 6 adds:

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

## 6. Ask about Gmail tracking

Refresh can keep the Progress board up to date from the Candidate's Gmail.
Explain it in plain words before asking, covering each of these points:

- On each Refresh, their Claude searches their Gmail for replies from the companies on their board: application confirmations, assessments, interview invitations, offers and rejections.
- It moves the matching card to Submitted, Interviewing, Offer or Closed, and the card shows the email behind the move: the company, the date and the subject line.
- Gmail is read-only: their Claude never sends, replies, labels, archives or deletes anything there.
- Email bodies never leave this computer; the dashboard keeps only the company, date and subject.
- A misread email is easy to undo: dragging the card back undoes the move, and that email never moves it again.
- It needs the Gmail connector connected to their claude.ai account (claude.ai, Settings, Connectors, Gmail), and they can switch it off at any time by running Setup again.

Then ask whether they want it on, and add their answer to the draft as `"gmailTracking": true` or `"gmailTracking": false`.
On a rerun, say what it is now and ask only if they want to change it.
When they choose it but no Gmail tools (such as `search_threads`) are available in this session, tell them to connect Gmail as above; Refresh skips Gmail until it is connected, so their choice still stands.

## 7. Show the draft and wait for confirmation

Show the draft in plain words (role types by priority, seniority, start window, each Location Tier, daily Queue target, each Resume Variant with its file, role types and keywords, the default first, and whether Gmail tracking is on), list your assumptions, and ask the Candidate to confirm or say what to change.
Redraft and show it again after every change.

Saving needs the Candidate's explicit confirmation of the draft as shown, given after they have seen it.
A request to save without looking ("just save it") still gets the draft shown and the question asked.
This step is complete only when the Candidate has confirmed the latest draft; until then nothing is validated, published or saved to the dashboard.

## 8. Check the draft against the dashboard contract

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

## 9. Publish the dashboard

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

## 10. Save the settings document

Write the validated document with `ArtifactData`: `action: "set"`, the dashboard `url`, `collection: "settings"`, `doc_id: "main"`, and the document as `data`.
When step 2 found an existing settings document, pass its `version` as `if_version`.
Read it back with `action: "get"`; Setup is done when the stored document matches what the Candidate confirmed.

## 11. Seed the Sources

List the `sources` collection with `ArtifactData` (`action: "list"`, the dashboard `url`).
For each of these documents that is missing, write it with `action: "set"`, after checking it with `node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate sources <doc-id> -` as in step 8, and with `updatedAt` from the same `date -u` command:

- `job-feed`: `{ "schemaVersion": 1, "enabled": true, "updatedAt": "<now>" }`
- `watchlist`: `{ "schemaVersion": 1, "enabled": true, "companies": [], "updatedAt": "<now>" }`
- `added-by-url`: `{ "schemaVersion": 1, "enabled": true, "postings": [], "updatedAt": "<now>" }`

Never overwrite a Source document that exists: the Candidate's switches, watchlist and added Postings live there.

## 12. Offer to import LinkedIn connections

This step is optional.
With the Candidate's LinkedIn connections in the Candidate folder, each Refresh drafts a short referral ask for connections who work at the companies in their Queue, and shows each one in that Posting's drawer with a copy button.
The Candidate sends every message themselves.

Ask once whether they want Referral Drafts.
On a rerun where `.job-app-assist/connections.json` exists, ask instead whether they have a newer export to import, since people change jobs.
A no is fine: skip to step 13.

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

## 13. Create the private answers file

Application forms ask for answers that must never sit in the dashboard database (hard rule 7): legal name and address, phone, work authorization and sponsorship, education details, and the voluntary demographic questions.
They live in `private-answers.md` in the Candidate folder, which Fill reads on this computer while it fills a form.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs private-answers init private-answers.md
```

It creates the file from a template with one line per question, and leaves an existing file exactly as it is, so a rerun never loses the Candidate's answers.
Ask the Candidate to open `private-answers.md` in the Candidate folder and write their answers after the colons in their own editor, and to tell you when they are done.
Typing the answers into the file keeps them out of the chat; if the Candidate prefers to give an answer in chat, write it into the file with the Edit tool and nowhere else.
Answers they leave blank are fine: Fill leaves those fields blank on each form and flags them for the Candidate.
Then check it, which prints only which questions are still blank:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs private-answers check private-answers.md
```

Never copy an answer from this file into the dashboard, a settings document or any other file.
If the Candidate wants to finish the file later, carry on; Fill reminds them when it runs.

## 14. Write the Style Guide

Refresh and Fill draft answers to the free-text questions on application forms ("Tell us about a project you are proud of"), and every draft follows the Candidate's Style Guide so it sounds like them rather than generic.
It lives in `style-guide.md` in the Candidate folder.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs style-guide init style-guide.md
```

It creates the file from a template, and leaves an existing file exactly as it is.
On a rerun where the file already has a tone, ask only whether the Candidate wants to change anything, and skip to the check below on a no.

Otherwise ask the Candidate, in one message, for three things:

1. How they sound when they write: plain or polished, short or detailed, how formal, anything they care about (for example "direct and warm, short sentences, numbers over adjectives").
2. Words or phrases they never want in their answers (for example "passionate about", "leverage", "I am excited to").
3. Two or three answers they wrote themselves for past applications or school essays, pasted in chat or as a file in the Candidate folder; these are optional but help the most.

Write their words into `style-guide.md` with the Edit tool: the tone under `## Tone` in their own phrasing, each phrase as a `- phrase` line under `## Phrases to avoid`, and each sample under `## Sample answers` below a `### <the question it answered>` heading.
Keep the template's comments, and never add a fact about the Candidate they did not give.
Show them the result and ask whether it sounds like them; edit it until they say it does.
They can also edit the file themselves at any time.
Then check it:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs style-guide check style-guide.md
```

It fails while the tone is empty; until it passes, Refresh and Fill draft no answers and leave free-text questions for the Candidate.
If the Candidate wants to finish it later, carry on.

## 15. Hand over

Give the Candidate the dashboard link and a one-line summary of the saved Search Profile, Resume Variants and Gmail tracking choice, and whether Referral Drafts are on.
Tell them the Search Profile appears at the top of the dashboard, and that News, Postings and Progress fill in once they refresh.
Mention the Sources button beside the tabs, where they can switch Sources on or off, follow companies on a watchlist, and add Postings by URL.
Say whether the Style Guide is written (and that AI-drafted answers follow it, marked as AI-drafted in each queued Posting's drawer, where the Candidate can edit them or write their own), how many questions `private-answers.md` still leaves blank, and that `/job-app-assist:fill` fills their queued applications in Helium once they have refreshed and queued some Postings.
