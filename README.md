# Job App Assist

A Claude Code plugin that lets your own Claude find, prepare and fill job applications on demand, so you only review and submit them.
Everything lands in a private dashboard in your own claude.ai account, with News, Postings and Progress tabs.
Your Claude never submits an application, never sends a message as you, and never signs in for you.

This is an early version: Setup, Refresh, the Queue, Sources, the News Digest, the Progress board, Settings and Tune work today, and Fill is on the way.

## What you need

- A Claude plan and the Claude desktop app, signed in with your claude.ai account
- Node.js 20 or newer
- Your resume as a PDF or Word file, or a few resumes each aimed at a different role type

## Install

```bash
claude plugin marketplace add dereksun64/job-app-assist
```

```bash
claude plugin install job-app-assist@job-app-assist
```

Then open a folder for your job search in the Code tab of the Claude desktop app and run `/job-app-assist:setup`, or just tell Claude you want to set up Job App Assist.
Describe the jobs you want in your own words, then point Claude at your resumes in that folder and give each a short label, such as "Backend SWE" or "AI/ML Engineer".
One resume is enough to start.
Confirm the Search Profile and Resume Variants Claude drafts, and Claude publishes your dashboard.
Your resume files stay in your folder; the dashboard only knows their labels.

## Refresh

Run `/job-app-assist:refresh`, or just ask Claude to refresh your jobs.
Claude pulls Postings from the Sources you switched on, keeps the ones that match your Search Profile, merges duplicates listed in several places, and ranks them: Location Tier first, then fit to your role types, company boosts (Fortune 500 companies and the Job Feed's company tiers) and freshness.
The ranked Job List appears on the Postings tab of your dashboard, with search and filters for role type, Location Tier, Source and how recently a Posting went up.
Each Posting shows the Resume Variant Claude picked for it.
Click a Posting to open its details, see why that Resume Variant was picked, and choose a different one if you disagree.
Claude ends with a short summary in chat, and says plainly when a Source could not be read.

## Queue

Each Refresh fills your Queue with the best-ranked Postings until it holds your daily Queue target, taking higher Location Tiers first.
Queued Postings are ticked and highlighted in the Job List; tick or untick any Posting with one click.
When you untick one, pick a quick reason (wrong role, location, company, too senior, or another reason): Refresh never queues that Posting again, and the Skipped filter lets you see and un-skip it.
The Queued filter shows just your picks, and the bar at the bottom always shows how many are queued, with a link to the Progress board.
Postings you haven't applied to stay queued from day to day with a badge saying how long they have waited, and after five days they are flagged as possibly closed.

## Sources

Open the Sources panel from the button beside the dashboard tabs to choose where Postings come from.
Each Source has an on/off switch, and Refresh reads only the ones that are on.

- **Job Feed**: the shared list of entry-level Postings every Candidate starts with.
- **Watchlist**: companies you follow directly.
  Paste a link to a company's Greenhouse, Lever or Ashby job board, and every Refresh reads its open jobs straight from that board, keeping the ones whose title says they are for interns, new grads or junior engineers.
- **Add by URL**: paste the link of any Posting you found elsewhere, with its company, title and location, and it joins your Job List on the next Refresh when it matches your Search Profile.
  This is the only way Postings from Runway or LinkedIn enter, since the Toolkit never opens those sites itself.

A job listed by several Sources appears once, with every Source it came from.

## Progress

The Progress tab is a board with a column for each Stage: Queued, Ready for Review, Submitted, Interviewing, Offer and Closed, each with its count.
Every queued Posting has a card there, and the Queued column is your Queue in the order Claude fills it.
While Claude fills an application, its card shows a spinner.
Drag a card to another column to record where it stands, or drag it back to undo a move.
Moving a card to Closed asks whether you were rejected or withdrew, and the card keeps the answer.
Click a card to open the same details as on the Postings tab, where you can also change its Stage.

## Settings and Tune

Two ways change what Refresh recommends, and both edit the same settings.
The Settings button on the dashboard opens a panel for your daily Queue target, role type priorities, Location Tiers, companies to boost, lower or block, apply sites to block, and how much freshness counts.
Or run `/job-app-assist:tune` and say what you want in your own words, such as "more AI startups and fewer defense contractors", "stop showing Workday-only postings" or "add PM rotational programs but rank them low".
Tune shows the exact list of changes and saves them only after you approve.
Ask Tune what your skips suggest, and it proposes changes from the reasons you gave when you unticked Postings, such as blocking a company you keep skipping.
The next Refresh ranks and queues with the new settings.

## Referral Drafts

If you like, Setup can import your LinkedIn connections, so you can ask people you know for a referral before you apply.
Download your connections from LinkedIn yourself (Settings & Privacy, then Data privacy, then Get a copy of your data, then Connections) and give Claude the `Connections.csv` file.
Claude keeps only each connection's name, company and position in your folder; email addresses and profile links are dropped, and the file never goes to your dashboard.
On each Refresh, Claude matches your connections to the companies in your Queue and writes a short referral ask for each one, at most three people per company.
Open a queued Posting to see its Referral Drafts, each with a copy button and a LinkedIn search for the person.
You send every message yourself; the Toolkit never sends anything and never opens LinkedIn.

## Developing

The plugin lives in `plugin/`, and the TypeScript source for the dashboard page, the dashboard contract and the `jaa` CLI lives in `src/`.
`plugin/dist/` is generated by `npm run build` and committed, because the plugin is installed straight from this repository.

```bash
npm install
```

```bash
npm run ci
```

```bash
npm run eval
```

`npm run ci` typechecks, lints, runs the tests and checks that `plugin/dist/` is up to date.
`npm run eval` runs the plugin eval suite in `plugin/evals/` with `claude plugin eval`.

Domain language is in [CONTEXT.md](CONTEXT.md), and design decisions are in [docs/adr/](docs/adr/).
