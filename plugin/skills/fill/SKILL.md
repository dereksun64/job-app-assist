---
name: fill
description: Fill the Candidate's queued job applications in Helium, stopping before submit. Works through the Queued cards on the Progress board in Queue order (or one Posting the Candidate names), opens each apply URL in a new Helium tab through Claude in Chrome, runs Simplify's Autofill, then checks and fills every field from the Candidate's private answers file, uploads the chosen Resume Variant, flags what the Candidate must answer, and moves each card to Ready for Review. Use when the Candidate asks to fill their Queue, fill applications, apply to their queued jobs, or fill one named Posting.
argument-hint: "[a Posting to fill, by company and title, or leave empty for the whole Queue]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs private-answers check private-answers.md) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill plan .job-app-assist/fill) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill plan .job-app-assist/fill --posting *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill start .job-app-assist/fill *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill finish .job-app-assist/fill *) Bash(rm -rf .job-app-assist/fill/state .job-app-assist/fill/out .job-app-assist/fill/results .job-app-assist/fill/started) Bash(mkdir -p .job-app-assist/fill/results) Bash(cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html) mcp__claude-in-chrome__tabs_context_mcp mcp__claude-in-chrome__tabs_create_mcp mcp__claude-in-chrome__navigate mcp__claude-in-chrome__computer mcp__claude-in-chrome__read_page mcp__claude-in-chrome__find mcp__claude-in-chrome__form_input mcp__claude-in-chrome__file_upload mcp__claude-in-chrome__get_page_text
---

# Fill

Fill puts the Candidate's answers into the live application form of each queued Posting, in a Helium tab, and stops before submit.
The Candidate then reviews each tab and makes every Submission themselves.
`jaa fill` decides what to fill and in which order, builds every card document Fill writes, and logs each application's token use; your part is the browser work and the judgment about each field.
The current working directory is the Candidate folder.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.
Four of them shape every step here:

- Never press a submit, apply, send or finish button that sends the application; stop with the form filled.
  Pressing a link or tab that only opens the form (an "Apply for this job" link that shows the form, an "Application" tab) is fine.
- Never type a password, sign in, or create an account; a page that asks for one ends Fill for that Posting (step 6).
- Work only through Claude in Chrome (the `mcp__claude-in-chrome__*` tools) in Helium.
  Never use computer use: no `mcp__computer-use__*` or other desktop-control tool, even to reach Simplify.
  The Claude in Chrome `computer` tool acts only inside the browser tab, so it is the tool for clicks, typing and screenshots.
- Sensitive answers come only from `private-answers.md` in the Candidate folder, and never go to the dashboard: no flag, note or result you write names the value of an answer, only the field.

## 2. Find the dashboard

Read `.job-app-assist/dashboard.json`.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
If it does not exist, tell the Candidate that Fill needs their dashboard first, ask them to run `/job-app-assist:setup`, and stop.

Read `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
When it differs from `pageVersion`, the Toolkit has a newer dashboard page:

```bash
cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html
```

Read the dashboard `url` with the `Artifact` tool, then publish `.job-app-assist/dashboard.html` to that `url` without passing `capabilities`, so the page keeps its database and its data.
Then save `pageVersion` in `.job-app-assist/dashboard.json` as the new version.
If the publish fails, say so in the summary and carry on.

## 3. Read the private answers

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs private-answers check private-answers.md
```

If it says there is no private file, tell the Candidate to run `/job-app-assist:setup` to create it, and stop.
Otherwise it names the questions the Candidate left blank, without printing any answer.
Read `private-answers.md` with the Read tool.
Each answer is a line `- Question: answer`; a blank answer means the Candidate answers that question on each form themselves.
Keep these answers in this conversation only: never write them to the dashboard, to a result file or to any other file.

## 4. Save the dashboard state

Start from a clean folder:

```bash
rm -rf .job-app-assist/fill/state .job-app-assist/fill/out .job-app-assist/fill/results .job-app-assist/fill/started
mkdir -p .job-app-assist/fill/results
```

Read with `ArtifactData`, saving the documents as files: pass `out_dir` as the absolute path of `.job-app-assist/fill/state` in the Candidate folder.

- `action: "get"`, `collection: "settings"`, `doc_id: "main"`.
- `action: "list"`, `collection: "cards"`, reading every page of the listing.
- `action: "list"`, `collection: "variantOverrides"`: the Resume Variants the Candidate chose in the drawer; it may be empty.

## 5. Plan

To fill the whole Queue:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill plan .job-app-assist/fill
```

When the Candidate named one Posting (by company and title, apply URL or Posting id, including text after `/job-app-assist:fill`), pass it on:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill plan .job-app-assist/fill --posting "<what the Candidate said>"
```

It prints the Queued cards to fill in Queue order, each with its apply URL and the absolute path of its chosen Resume Variant file, and saves them in `.job-app-assist/fill/out/plan.json`.
If it lists several matches, ask the Candidate which one they mean and plan again with its Posting id.
If it says the Posting is not Queued, has no match, or a resume is missing, tell the Candidate what it says and stop.
With an empty Queue, tell the Candidate to tick Postings on the Postings tab (the dashboard `url` followed by `#postings`) and stop.

Then call `mcp__claude-in-chrome__tabs_context_mcp` with `createIfEmpty: true`.
If Claude in Chrome is not connected, tell the Candidate to open Helium and check that the Claude extension is signed in there, and stop before marking any card.
Work through the planned Postings one at a time, in order, with steps 6 to 9 for each.

## 6. Start the Posting

Mark the card as filling, so its card shows a spinner on the board:

1. Read the card fresh with `ArtifactData` (`action: "get"`, `collection: "cards"`, the Posting id as `doc_id`, `out_dir` as in step 4) and note its `version`.
2. Run, with that version:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill start .job-app-assist/fill <posting id> --version <version>
   ```

3. Send the batch in `.job-app-assist/fill/out/writes.json` with `ArtifactData`, `action: "batch"`, exactly as listed.
   If it is refused because the card changed, read it again and repeat once.
   If `jaa fill start` says the card is no longer Queued, the Candidate moved it: skip this Posting.

Open the apply URL with `mcp__claude-in-chrome__tabs_create_mcp` and `mcp__claude-in-chrome__navigate`, so every application gets its own new tab in the Claude tab group in Helium, the Ready to submit group, apart from the Candidate's own tabs.
Leave each tab open when you finish with it: it is where the Candidate reviews and submits.

When the page shows the job description with a link or tab that opens the application form, open the form.
Never use an "Apply with LinkedIn" or similar button that signs in through another site.
When the page asks the Candidate to sign in or create an account before the form (Workday, iCIMS, Taleo and similar sites usually do, and the plan marks them), stop on that page and finish the Posting with outcome `needs_sign_in` (step 9) and a `sign_in` flag, for example `{ "field": "Workday account", "kind": "sign_in", "note": "Sign in to Acme's Workday in Helium, then ask your Claude to fill this Posting again." }`.
When the Posting is closed, the page will not load, or the form cannot be reached, finish it with outcome `stopped` and a `problem` flag saying what you saw.

## 7. Run Simplify's Autofill

Take a screenshot of the tab with the `computer` tool (`scale: 0.5` is enough to find the panel; coordinates stay in the full-size frame).
Simplify Copilot shows a panel at the side of the form with an "Autofill This Page" button.
The panel is not in the page's accessibility tree, so `find` and `read_page` cannot see it: click the button by its position in the screenshot with the `computer` tool's `left_click`.
Simplify then fills the standard fields over about 30 seconds: wait with the `computer` tool's `wait` action (10 seconds at a time) and take a screenshot until it says it is done or a minute has passed.
Record how it went for step 9's `simplify`: `filled` when it filled fields, `absent` when no Simplify panel appeared, `failed` when it appeared but filled nothing or showed an error.
When the panel offers to answer the free-text questions with AI or to submit, ignore it.

## 8. Check and fill every field

Read the whole form with `read_page` (`filter: "interactive"`), scrolling and reading again on long forms, so no field is missed.
For every field, decide what it should hold, compare that with what is in it now (Simplify may have filled it wrongly), and fix it:

- **Personal facts and sensitive answers** (name, email, phone, address, links, work authorization, sponsorship, education, start date, relocation, salary, demographic and self-identification questions): use the answer in `private-answers.md`.
  Replace anything Simplify put there that differs.
  When the private file leaves that answer blank or has no matching question, clear the field if Simplify filled it and flag it as `missing_answer`.
  For demographic questions, use the form's option that matches the Candidate's answer, including "Decline to self-identify" when they wrote "Decline to answer".
- **Legal claims** (whether the Candidate meets the basic or minimum qualifications, certifies their answers, agrees to terms, a privacy policy or a background check, has worked for or is related to someone at the company, or any other statement about themselves the form asks them to confirm): leave it blank or unchecked and flag it as `legal_claim`, unless the private file answers that exact question.
- **Free-text questions** (cover letter, "Why this company?", "Anything else?", any open answer longer than a few words): leave them as they are without writing an answer, and flag each as `free_text` so the Candidate writes it.
  Clear any text Simplify put there that is clearly not the Candidate's.
- **Anything you are not sure about**: leave it blank and flag it as `uncertain`, saying what you were unsure of.
  Never guess, and never pick a likely option to fill a required field.
- **Resume**: upload the planned Resume Variant file with `mcp__claude-in-chrome__file_upload`, passing its absolute path from the plan and the `ref` of the resume file input from `find` or `read_page`; never click a file input, since that opens a picker you cannot reach.
  If Simplify attached a different resume, replace it.
  Leave cover letter uploads empty.
  If the upload fails or the form has no resume input, flag it as `resume`.

How to fill each kind of field:

- Text boxes, native selects, checkboxes and radio buttons: `form_input` with the field's `ref`.
- Searchable dropdowns (Greenhouse, Ashby and Lever often use these): click the field with the `computer` tool, type the option, wait a moment, then press Enter, and read the field again to check the choice took.
- After filling, read the form once more and compare every required field: each one is either filled with the right answer or flagged.

Never press the submit button, even when every field is filled, and never press Enter in a field where it would send the form.

Keep a flag for every field the Candidate must look at, each as `{ "field": "<label as the form shows it>", "kind": "<kind>", "note": "<one sentence: what to check or do>" }`.
The note says what to do, never the answer: write "Not in your private file; answer it yourself.", not the value.
Keep the list to 40 flags at most, grouping similar ones.

## 9. Finish the Posting

Write the result with the Write tool to `.job-app-assist/fill/results/<posting id>.json`:

```json
{
  "outcome": "filled",
  "simplify": "filled",
  "resumeVariant": "<the Resume Variant name you uploaded>",
  "flags": [
    { "field": "Why Acme?", "kind": "free_text", "note": "Write this answer in your own words." }
  ]
}
```

`outcome` is `filled` when the form is filled up to submit, `needs_sign_in` when a sign-in or account stopped you (with a `sign_in` flag), or `stopped` when anything else did (with a `problem` flag).
`simplify` is `filled`, `absent` or `failed`, or `not_tried` when you stopped before Simplify.
Leave out `resumeVariant` when you uploaded no resume.
`kind` is one of `uncertain`, `legal_claim`, `free_text`, `missing_answer`, `resume`, `sign_in` or `problem`.

Then read the card fresh with `ArtifactData` (`action: "get"`, as in step 6) and, with its version:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs fill finish .job-app-assist/fill <posting id> --version <version>
```

If it lists problems with the result file, fix the file and run it again.
Send the batch in `.job-app-assist/fill/out/writes.json` with `ArtifactData`, `action: "batch"`, exactly as listed, reading the card again and repeating once if it is refused because the card changed.
A filled card moves to Ready for Review with its flags; a card that needs a sign-in or stopped stays Queued with its flags; the filling marker clears either way.
`jaa fill finish` prints the application's token use and the running average, and logs them in `.job-app-assist/fill/usage.jsonl` on this computer; keep the numbers for the summary.

Give the Candidate a one-line update after each Posting (company, title, outcome, number of flags), so they can start reviewing the first tabs while the rest fill.
If anything stops Fill part way through a Posting, still finish that Posting with outcome `stopped`, so its card never stays marked as filling.

## 10. Summarize in chat

Finish with a short summary:

- each Posting as company and title, with what happened: filled with how many flags (and the flagged fields in a few words), needs a sign-in (and what the Candidate must do), or stopped (and why);
- that every filled application is in its own tab in the Claude tab group in Helium, filled up to the submit button, and that the Candidate reviews each one, answers the flagged fields and presses submit themselves;
- how Simplify did across the Postings;
- the token use per application and the running average from `jaa fill finish`;
- a link to the Progress board (the dashboard `url` followed by `#progress`), where each card lists what Fill flagged.

Keep it to a few lines.
