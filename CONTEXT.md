# Job App Assist

A shareable toolkit that lets anyone have their own Claude find, prepare and fill job applications on demand, so they only have to review and submit them.

## Language

### People and setup

**Candidate**:
A person using the toolkit to apply for jobs; each Candidate's data is private to them and their own Claude.
_Avoid_: User, applicant

**Toolkit**:
What a Candidate installs to get started: a Claude Code plugin holding the master instructions their Claude follows, which also creates and maintains that Candidate's own dashboard.
_Avoid_: App, bot, extension

**Search Profile**:
The Candidate's standing criteria for which Postings are worth applying to: role types, seniority, start window, and preferred locations.
_Avoid_: Filter, preferences, criteria

**Location Tier**:
A ranked group of locations in the Search Profile; lower tiers only fill slots that higher tiers leave empty.
_Avoid_: Location preference, region

**Resume Variant**:
One of a small, fixed set of hand-written resumes, each aimed at a role type; the tool picks one per Posting and never edits its content.
_Avoid_: Tailored resume, resume version

**Tidy**:
Making room in a full dashboard by removing old history the Candidate approves: cards Closed for a while with their answers, leftovers with no card, old skips and old News Digests; never open cards, settings, Sources or the Job List.
_Avoid_: Cleanup, purge, prune

**Style Guide**:
The Candidate's written description of how they sound (tone, phrases to avoid, sample answers), which every AI-drafted answer follows.
_Avoid_: Voice profile, tone settings

### Finding jobs

**Source**:
A place Postings come from, which the Candidate can switch on or off from the dashboard.
_Avoid_: Feed (for the general concept), scraper, integration

**Job Feed**:
The shared Source every Candidate starts with: the continuously refreshed `jobs.json` published by yet-another-job-repo.
_Avoid_: Job board, source list

**Watchlist**:
A Source made of companies the Candidate follows directly, each read from its own public Greenhouse, Lever or Ashby job board.
_Avoid_: Company list, favorites, followed companies

**Posting**:
One open job at one company, as listed by a Source, identified by its apply URL.
_Avoid_: Job, listing, opening

**Job List**:
Every Posting from the Candidate's enabled Sources that matches their Search Profile.
_Avoid_: Feed, results, matches

**Queue**:
The Postings the Candidate intends to apply to; some are added automatically by rank, the rest by hand.
_Avoid_: Cart, shortlist, batch

**Refresh**:
The on-demand daily update the Candidate starts by asking their Claude in chat: pull Postings from enabled Sources, rebuild the Job List, re-rank and pre-fill the Queue, update Stages from email, and build the News Digest.
_Avoid_: Run, sync, cron, nightly job

### Applying

**Prepared Application**:
Everything needed to apply to one queued Posting, assembled without touching the application form: the chosen Resume Variant, field values, and answers to its questions.
_Avoid_: Draft, filled app, pending application

**Research Brief**:
Notes on one company and role for the Candidate to write an answer from themselves, instead of an AI-drafted answer.
_Avoid_: Company summary, cheat sheet

**Referral Draft**:
A suggested message asking one of the Candidate's connections at a queued Posting's company for a referral; only the Candidate ever sends it.
_Avoid_: Outreach, intro request

**Fill**:
Putting a Prepared Application into the live application form in a browser tab, stopping before submit.
_Avoid_: Autofill (as a noun), pre-fill

**Review**:
The Candidate going through Filled tabs and the dashboard, making each Submission or skipping it.
_Avoid_: Morning review, approval, check-in

**Submission**:
The Candidate pressing submit on an application; only the Candidate ever does this, never the tool.
_Avoid_: Apply (as a tool action), send

**Stage**:
Where a queued Posting is in its whole lifecycle, shown as a column on the Progress board: Queued, Ready for Review, Submitted, Interviewing, Offer, or Closed (rejected or withdrawn). A Posting being Filled stays Queued, marked as filling.
_Avoid_: Status, application status, column, step

**Stage evidence**:
The company, date and subject of the email behind a Stage move Refresh made from the Candidate's Gmail, shown on the card; never the email's body. Dragging the card back undoes the move, and that email never moves the card again.
_Avoid_: Proof, email log, email record

### Staying informed

**News Digest**:
A summary built on each Refresh of what the Candidate should know: hiring signals from the Postings themselves, forum discussion, news about companies in the Queue, and broader tech-industry news.
_Avoid_: News feed, briefing, updates
