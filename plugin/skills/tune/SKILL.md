---
name: tune
description: Tune the Candidate's recommendations. Turns plain-language requests ("more AI startups, fewer defense contractors", "stop showing Workday-only postings", "add PM rotational programs but rank them low", "queue 10 a day") and patterns in their skip reasons into an exact settings diff, shows it, and saves it only after they approve. Use when the Candidate wants to change what gets recommended, ranked, boosted, blocked or queued, or asks what their skips suggest.
argument-hint: "[what to change, in your own words]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs tune-report .job-app-assist/tune) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs settings-diff *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate *) Bash(rm -rf .job-app-assist/tune/state) Bash(mkdir -p .job-app-assist/tune) Bash(date -u *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard check .job-app-assist) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard record .job-app-assist *)
---

# Tune

Tune changes the Candidate's settings document, `settings/main`, the same document the dashboard's Settings panel edits.
It turns what the Candidate says, and what their skip reasons show, into an exact list of changes, shows that list, and saves it only after the Candidate approves it.
The next Refresh ranks the Job List and fills the Queue with the new settings.
The current working directory is the Candidate folder.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.

## 2. Find the dashboard

Read `.job-app-assist/dashboard.json`.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
If it does not exist, tell the Candidate that Tune needs their dashboard first, ask them to run `/job-app-assist:setup`, and stop.
If the `ArtifactData` tool is not available, tell the Candidate that Tune needs Claude Code signed in with the claude.ai account that owns their dashboard, and stop; nothing has changed.

Then bring the dashboard page up to date:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard check .job-app-assist
```

When it says the Toolkit has a newer dashboard page, read the dashboard `url` with the `Artifact` tool, then publish `.job-app-assist/dashboard.html` to that `url` without passing `capabilities`, so the page keeps its database and its data, and run the `jaa dashboard record` command it printed.
If the publish fails, say so at the end and carry on.
When it says the page is up to date, or newer than this Toolkit, there is nothing to publish.

## 3. Save the dashboard state

```bash
rm -rf .job-app-assist/tune/state
mkdir -p .job-app-assist/tune
```

Read with `ArtifactData`, the dashboard `url`, and `out_dir` set to the absolute path of `.job-app-assist/tune/state` in the Candidate folder:

- `action: "get"`, `collection: "settings"`, `doc_id: "main"`.
  Note the `version` it reports; the save in step 8 is pinned to it.
  If there is no settings document, ask the Candidate to finish `/job-app-assist:setup` and stop.
- `action: "list"`, `collection: "skips"`, reading every page.
- `action: "list"`, `collection: "postings"`, reading every page.

Then run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs tune-report .job-app-assist/tune
```

It prints the current settings, the Candidate's skip reasons from the last 90 days with the changes they suggest, and the companies and apply sites in the Job List.

## 4. Understand the settings

The settings Tune changes, and what each does on the next Refresh:

- `dailyQueueTarget` (1 to 100): how many Postings the Queue is topped up to each Refresh.
- `searchProfile.roleTypes`: each role type with a `priority` of `high`, `medium` or `low`.
  Priority is half of a Posting's score; a role type that is not listed is left out of the Job List.
- `searchProfile.locationTiers`: Tier 1 first; lower tiers only fill Queue slots higher tiers leave empty.
  Each location sits in exactly one tier.
- `searchProfile.seniority` and `searchProfile.startWindow`: which levels and start months count.
- `companies.boost`: ranked as high as the top company tiers.
  `companies.lower`: ranked below every company with no rule.
  `companies.block`: left out of the Job List.
  A company sits in at most one of the three lists; names match ignoring case, punctuation and suffixes such as Inc.
- `blockedApplySites`: host names such as `myworkdayjobs.com`; a Posting whose every apply URL is on one of these sites, or a subdomain of one, is left out.
- `freshnessWeight` (0 to 50, default 20): the percent of the score that comes from how recently a Posting was posted.
  Role type priority and company boosts share the rest, five parts to three.

Leave `resumeVariants` and every other field as they are unless the Candidate asks to change them.

## 5. Draft the change

Copy the saved settings document and change only what the Candidate asked for, or what a skip pattern they accepted calls for.
Keep `schemaVersion`, and set `updatedAt` from `date -u +%Y-%m-%dT%H:%M:%SZ`.

- Requests about kinds of company ("AI startups", "defense contractors", "big banks") become named companies in `companies`.
  Name companies from the Job List companies in the report first, using their spelling there, then other well-known companies of that kind the Candidate is likely to see.
  List every company you chose, so the Candidate can drop any they disagree with.
  "More" or "prefer" means `boost`, "fewer" or "less" means `lower`, and "no", "never" or "stop showing" means `block`.
- Requests about an applicant tracking system ("Workday-only postings", "iCIMS") become its host in `blockedApplySites`: Workday is `myworkdayjobs.com`, iCIMS is `icims.com`, Taleo is `taleo.net`, SuccessFactors is `successfactors.com`.
  Check the Job List apply sites in the report for the exact host.
- A new kind of role ("PM rotational programs") becomes a role type named the way job titles say it, at the priority the Candidate asked for ("rank them low" is `low`).
- When the Candidate asks what their skips suggest, or asks for no particular change, propose the suggestions from the report, each with its evidence.
  Also look across the skipped companies for a shared kind (an industry, company size or sector) that the report cannot see, and offer it as one more suggestion with the companies it covers.
  Each suggestion is the Candidate's to accept or turn down; draft only the ones they accept.

Save the draft with the Write tool as `.job-app-assist/tune/proposed.json`, then check it and get the exact diff:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs settings-diff .job-app-assist/tune/state/settings/main.json .job-app-assist/tune/proposed.json
```

If it reports problems, fix the draft and run it again.
If it reports no changes, tell the Candidate their settings already say that, and stop.

## 6. Show the diff and wait for approval

Show the Candidate the change list exactly as `settings-diff` printed it, followed by one plain sentence per change on what it does to their Job List or Queue, and any assumptions you made.
Ask them to approve it, or say what to change.
After any change they ask for, redraft, run `settings-diff` again, and show the new list.

Saving needs the Candidate's explicit approval of the latest diff, given after they have seen it.
A request to save without looking ("just do it", "don't show me") still gets the diff shown and the question asked.
Approval of an earlier diff does not carry over to a changed one.
Until the Candidate approves, nothing is written to the dashboard.

## 7. Check the approved document

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate settings main .job-app-assist/tune/proposed.json
```

It must print `settings/main matches the dashboard contract.`

## 8. Save it

Write the approved document with `ArtifactData`: `action: "set"`, the dashboard `url`, `collection: "settings"`, `doc_id: "main"`, `file_path` set to the absolute path of `.job-app-assist/tune/proposed.json`, and `if_version` set to the version step 3 read.

If the write is refused because the document changed since step 3 (for example, the Candidate changed something in the Settings panel meanwhile), go back to step 3, apply the same approved changes to the new document, and show the diff again before saving.
Read the document back with `action: "get"`; Tune is done when it matches what the Candidate approved.

## 9. Hand over

Tell the Candidate their settings are saved, that the dashboard's Settings panel shows them, and that the next Refresh ranks and queues with them.
Postings already in the Queue stay there; a newly blocked company's queued Postings can be unticked on the Postings tab.
Offer to run `/job-app-assist:refresh` now.
