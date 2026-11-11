# Job App Assist

A Claude Code plugin that lets your own Claude find, prepare and fill job applications on demand, so you only review and submit them.
Everything lands in a private dashboard in your own claude.ai account, with News, Postings and Progress tabs.
Your Claude never submits an application, never sends a message as you, and never signs in for you.

Setup, Refresh, the Queue, Sources, the News Digest, the Progress board, Settings, Tune, Referral Drafts, Prepared Applications, Fill and Tidy all work today.
It runs on a Mac.

## What you need

- **A Claude plan** (Pro, Max or a Team or Enterprise seat): all the work runs on your own plan's usage, with no other bill.
- **The Claude desktop app**, signed in with your claude.ai account.
  You use it from its **Code** tab, in a folder for your job search.
- **Node.js 20 or newer**, from [nodejs.org](https://nodejs.org).
  The Toolkit's small helper program runs on it.
- **Your resume** as a PDF or Word file, or a few resumes each aimed at a different role type.
- **For Fill**, on the same Mac:
  - the [Helium](https://helium.computer) browser, where your applications are filled, apart from your own browser;
  - the [Claude extension](https://chromewebstore.google.com/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn) (Claude in Chrome) added to Helium and signed in with the same claude.ai account;
  - [Simplify Copilot](https://chromewebstore.google.com/detail/pbanhockgagggenencehbnadejlgchfc) added to Helium, signed in, with your Simplify profile filled in.
- **Optionally, the Gmail connector** (claude.ai, Settings, Connectors, Gmail), if you want Refresh to move your Progress board cards from companies' replies.

Setup checks each of these and tells you how to fix anything missing.

## Install

```bash
claude plugin marketplace add dereksun64/job-app-assist
```

```bash
claude plugin install job-app-assist@job-app-assist
```

Then open a folder for your job search in the Code tab of the Claude desktop app and run `/job-app-assist:setup`, or just tell Claude you want to set up Job App Assist.
Setup first checks the prerequisites above: Node.js, Helium, the Claude extension and whether it is connected, Simplify, and the Gmail connector if you want it.
Only a missing Node.js stops it; anything else Fill needs is listed with its fix, and you can finish it later.
Describe the jobs you want in your own words, then point Claude at your resumes in that folder and give each a short label, such as "Backend SWE" or "AI/ML Engineer".
One resume is enough to start.
Confirm the Search Profile and Resume Variants Claude drafts, and Claude publishes your dashboard.
Your resume files stay in your folder; the dashboard only knows their labels.
Last, Setup creates `private-answers.md` in your folder: write your sensitive answers there (legal name and address, work authorization, education details, demographic questions) in your own editor.
That file stays on your computer and never goes to your dashboard; leave blank anything you would rather answer on each form yourself.
Then Setup writes your Style Guide, `style-guide.md`: how you sound, phrases you never use, and a few answers you wrote yourself.
Every answer Claude drafts for you follows it, so it sounds like you rather than generic.

Run Setup again whenever you want to change your Search Profile, resumes, Gmail tracking or Style Guide, or to check your prerequisites again.
Rerunning never loses data: your dashboard is updated in place, and your answers and settings are kept unless you change them.
If you set up in a new folder, Setup finds your existing dashboard and offers to keep using it.

## Commands

Every command works by name or in plain words; the names are the surest way to start the one you mean.

| Command                                 | What it does                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `/job-app-assist:setup`                 | Checks your prerequisites, saves your Search Profile and resumes, makes your dashboard |
| `/job-app-assist:refresh`               | Updates your Job List, Queue, News Digest and Prepared Applications                    |
| `/job-app-assist:fill`                  | Fills your queued applications in Helium, stopping before submit                       |
| `/job-app-assist:fill Acme new grad`    | Fills just that Posting                                                                |
| `/job-app-assist:tune more AI startups` | Changes what gets recommended, after you approve the exact changes                     |
| `/job-app-assist:tidy`                  | Makes room when your dashboard storage is full                                         |

A good day: run `/job-app-assist:refresh` in the morning, look over your Queue and answers on the dashboard, then run `/job-app-assist:fill` and submit the filled tabs in Helium yourself.

## How many applications a day

Your daily Queue target sets how many Postings Refresh queues each day, and so how much of your Claude plan Fill uses.
Filling one Greenhouse application in a live test took about 4 minutes, 25 model responses and 10,000 output tokens, with Simplify filling the standard fields first.
Refresh also prepares answers and a Research Brief for each queued Posting.
Realistic daily targets to start from:

| Claude plan | Daily Queue target |
| ----------- | ------------------ |
| Pro         | 5                  |
| Max 5x      | 15                 |
| Max 20x     | 40                 |

On a Team or Enterprise seat, start at 5.
These come from one measured application, and forms vary, so treat them as starting points.
Claude logs the tokens each application uses in `.job-app-assist/fill/usage.jsonl` in your folder and reports the running average after each one; compare it with your usage in claude.ai (Settings, Usage) and raise or lower your target in the Settings panel or with `/job-app-assist:tune`.
Starting Fill in a new session keeps each response small, so the same plan fills more applications.

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

## Prepared Applications

Each Refresh also prepares the free-text questions on your queued applications ("Why do you want to join Figma?", "Tell us about a project you are proud of").
For Greenhouse forms it reads the questions ahead from Greenhouse's public job board, without opening the form; other sites are prepared by Fill from the live form.
Claude drafts an answer to every question in your voice, following your Style Guide and your resume, and writes a Research Brief for the company: what it does, recent news, the team, how the role fits your background, and a LinkedIn search for its recruiters that you open yourself.

Each question starts in one of two modes, by its type:

- **AI draft**: Fill types the drafted answer, marked AI-drafted in the drawer so you know to read it closely.
- **My own words**: questions about why this company or this role, where your own words count most, start here.
  You write the answer from the Research Brief, typed or with your Mac's dictation, and Fill types only what you wrote; until you do, Fill leaves the question blank and flags it.

Open a queued Posting to see its answers and Research Brief.
Edit any answer, or switch any question between the two modes with one click; both texts are kept.
The answers are free-text only: your personal details stay in `private-answers.md`.

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
Cards Claude has filled say how many fields to check, and their details list each one.

## Fill

Run `/job-app-assist:fill`, or ask Claude to fill your queue; add a company and title (`/job-app-assist:fill Acme new grad`) to fill just that Posting.
Claude works through the Queued column of your board in order, and each card shows a spinner while its application fills.
Each application opens in its own new tab in Helium, in the Claude extension's tab group, apart from your own tabs, so you can keep using your computer.
Claude clicks Simplify's "Autofill This Page" first, then reads every field, fixes what Simplify got wrong or left empty from your private answers file, and uploads the Resume Variant chosen for that Posting.
Claude never presses submit: each filled card moves to Ready for Review, and its details list every field Claude flagged for you.
Free-text questions get your Prepared Application's answers: the AI draft, your edit of it, or your own words; a Posting with none is prepared from the form first.
Claude flags instead of guessing: questions it is unsure of, claims about you (such as "Do you meet the basic qualifications?"), answers missing from your private file, and questions you chose to write yourself but have not written yet.
Postings that need a sign-in or a new account (Workday, for example) stay Queued with a flag: sign in yourself in Helium and ask Claude to fill that Posting again.
You can review and submit the first tabs while the rest are still filling.

Claude logs the tokens each application used in `.job-app-assist/fill/usage.jsonl` in your folder and reports the running average after each one, so you can size your daily Queue target to your Claude plan (see [How many applications a day](#how-many-applications-a-day)).

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

## Updates and your dashboard

Update the Toolkit with:

```bash
claude plugin update job-app-assist@job-app-assist
```

When an update brings a new dashboard design, the next command you run (Refresh, Fill, Tune, Setup or Tidy) republishes your dashboard page in place.
Your data lives in the dashboard's database, not the page, so nothing is lost; the version at the bottom of the dashboard shows which page you have.

## When your dashboard storage is full

A dashboard holds at most 25,000 documents and a limited total size, which takes many months of daily use to fill.
If it fills up, the dashboard and your Claude both say so, and nothing you saved before is lost.
Run `/job-app-assist:tidy`: it lists the old history it can remove (cards Closed for 30 days or more with their answers, leftovers with no card, skips older than 180 days and News Digests older than 90 days) and removes it only after you approve.
Open cards, settings, Sources and your Job List always stay.

## Developing

The plugin lives in `plugin/`, and the TypeScript source for the dashboard page, the dashboard contract and the `jaa` CLI lives in `src/`.
`plugin/dist/` is generated by `npm run build` and committed, because Claude Code installs the plugin straight from this repository and runs no build step (see [ADR 0004](docs/adr/0004-built-plugin-files-are-committed.md)).
When a merge or rebase conflicts on `plugin/dist/`, never edit it by hand: take either side, run `npm run build`, and commit the result.

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
