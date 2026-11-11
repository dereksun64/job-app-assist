---
name: refresh
description: Refresh the Candidate's Job List, Queue and News Digest. Pulls Postings from the Candidate's enabled Sources (the Job Feed, their watchlist companies' job boards and Postings they added by URL), keeps the ones that match the Search Profile, ranks them, picks a Resume Variant for each, pre-queues the best ones up to the daily Queue target, drafts referral asks for the Candidate's connections at queued companies, writes them to the dashboard's Postings tab, moves Progress board cards from the Candidate's Gmail replies when they opted in, builds the day's News Digest for the News tab, prepares answers and Research Briefs for queued Postings, and ends with a short summary in chat. Use when the Candidate asks to refresh, update their jobs, see today's Postings, check their applications' status or catch up on the news.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh --rerun) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs news plan .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs news build .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs gmail plan .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs gmail match .job-app-assist/refresh) WebSearch WebFetch(domain:news.ycombinator.com) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs prepare plan .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs prepare build .job-app-assist/refresh) Bash(rm -rf .job-app-assist/refresh/state .job-app-assist/refresh/out .job-app-assist/refresh/prepared) Bash(mkdir -p .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard check .job-app-assist) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard record .job-app-assist *)
---

# Refresh

Refresh rebuilds the Candidate's Job List: every Posting from their Sources that matches their Search Profile, ranked best first, on the Postings tab of their dashboard.
It then tops up the Queue: the best-ranked Postings are pre-queued until the Queue holds the daily Queue target, higher Location Tiers first.
Unsubmitted Queue items carry over and count toward the target, and a Posting the Candidate skipped is never pre-queued again.
When the Candidate opted in, it reads their Gmail, read-only, and moves Progress board cards on replies from companies, keeping each email's company, date and subject as evidence.
Last, it builds the day's News Digest on the News tab: hiring signals from the Job List, forum highlights, news about companies in the Queue, and 5 to 8 industry stories.
When the Candidate imported their LinkedIn connections, queued Postings also get Referral Drafts: a short message asking a connection at the Posting's company for a referral, which the Candidate copies from the drawer and sends themselves.
Queued Postings also get Prepared Applications: an answer to each free-text question on the form, AI-drafted to the Candidate's Style Guide or left for the Candidate to write from a Research Brief, which they review in the drawer before Fill types them.
The ranking, filtering, dedupe, Resume Variant picks, pre-queueing and connection matching happen in `jaa refresh`, a deterministic program, `jaa gmail` matches emails to cards, and `jaa news` computes the hiring signals; your part is to hand them the dashboard state, review the picks `jaa refresh` is unsure about, write the Referral Drafts, gather the news in chat, apply what they produce, and tell the Candidate what changed.
The current working directory is the Candidate folder.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.

## 2. Find the dashboard

Read `.job-app-assist/dashboard.json`.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
If it does not exist, tell the Candidate that Refresh needs their dashboard first, ask them to run `/job-app-assist:setup`, and stop.

## 3. Bring the dashboard page up to date

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs dashboard check .job-app-assist
```

When it says the Toolkit has a newer dashboard page, read the dashboard `url` with the `Artifact` tool, then publish `.job-app-assist/dashboard.html` to that `url` without passing `capabilities`, so the page keeps its database and its data, and run the `jaa dashboard record` command it printed.
If the publish fails, say so in the summary and carry on; the data still updates.
When it says the page is up to date, or newer than this Toolkit, there is nothing to publish.

## 4. Save the dashboard state

Start from a clean state folder:

```bash
rm -rf .job-app-assist/refresh/state .job-app-assist/refresh/out .job-app-assist/refresh/prepared
mkdir -p .job-app-assist/refresh
```

Read with `ArtifactData`, saving the documents as files: pass `out_dir` as the absolute path of `.job-app-assist/refresh/state` in the Candidate folder.

- `action: "get"`, `collection: "settings"`, `doc_id: "main"`.
  If there is no settings document, ask the Candidate to finish `/job-app-assist:setup` and stop.
- `action: "list"`, `collection: "sources"`.
  These hold the Candidate's Source switches, their watchlist and the Postings they added by URL; a missing document means that Source is on with nothing added.
- `action: "list"`, `collection: "postings"`.
  An empty collection is normal before the first Refresh.
- `action: "list"`, `collection: "cards"`, then `action: "list"`, `collection: "skips"`.
  These hold the Queue and the Postings the Candidate skipped; both are empty until the first Refresh or the first tick.
  Read every page of each listing, so no queued or skipped Posting is missed.
- `action: "list"`, `collection: "news"`.
  It holds one News Digest per day; it is empty before the first digest.
- `action: "list"`, `collection: "referrals"`, every page.
  It holds the Referral Drafts earlier Refreshes wrote, and is empty until then.
- `action: "list"`, `collection: "applications"`, every page, then `action: "list"`, `collection: "variantOverrides"`.
  They hold the Prepared Applications already written (Refresh never replaces one, since the Candidate may have edited it) and the Resume Variants the Candidate chose in the drawer; both may be empty.

Each read reports a `version` for every document.
Use the Write tool to save `.job-app-assist/refresh/versions.json` mapping each postings, cards, news and referrals document you read to its version, for example `{ "postings/meta": 4, "postings/page-1": 4, "cards/0123456789ab": 2, "news/2026-11-09": 1, "referrals/0a1b2c3d4e5f": 2 }`, or `{}` when there were none.
Card versions let Gmail tracking move a card without overwriting a move the Candidate makes at the same time; `jaa refresh` itself only creates new cards.
Skips and applications need no versions: Refresh never changes a skip, and only creates a Prepared Application where there is none.
Do not open the saved files; `jaa refresh` reads them.

## 5. Build the Job List

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh
```

It reads only the Sources that are switched on: the Job Feed (resolving its short links to the real application sites) and each watchlist company's public Greenhouse, Lever or Ashby job board.
Postings added by URL are never opened; Refresh uses the company, title and location the Candidate typed, so Runway and LinkedIn links are never visited.
It then filters, merges duplicates across Sources, ranks, picks a Resume Variant for every Posting, pre-queues the best Postings as new cards, checks every document against the dashboard contract, and writes the documents and the ArtifactData batches to `.job-app-assist/refresh/out/`.
It prints the summary you will report.
If it exits with an error, nothing has been written to the dashboard: fix what the message names (usually a missing version in `versions.json`) and run it again.
If it says the settings document does not match the dashboard contract (for example, it has no `resumeVariants`), ask the Candidate to run `/job-app-assist:setup` again to bring their settings up to date, and stop.
A Source that fails does not stop it; the summary marks it `FAILED`, and the Postings it gave on the last Refresh are kept.
The same goes for each watchlist company's board on its own.

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
Unsure picks beyond the listed ones keep their pick and come up again on a later Refresh.

## 7. Write Referral Drafts

`jaa refresh` reads the Candidate's connections from `.job-app-assist/connections.json` when Setup imported them, and matches them to the companies of queued Postings.
When the summary has no "Referral Drafts" line, the Candidate has not imported connections: skip this step.
When it says there are drafts to write, read `.job-app-assist/refresh/out/referral-review.json`.
It holds `toDraft` (how many matches have no draft yet) and `companies`, best-ranked first, each with:

- `key`: the name to record your calls under, exactly as given;
- `company` and `roles`: the company's best-ranked queued Postings (title, role type, apply URL);
- `connections`: the people there to write to (name, company, position).

Each connection gets one message per company, which every queued Posting at that company shows in its drawer, so the Candidate never sends one person several near-identical asks.

For each connection, first check that they really work at the company.
The match is by name, so it can be wrong: "Amazon" and "Amazon Web Services" are one employer, but a "Delta Dental" connection is not at "Delta Air Lines".
When it is clearly another employer, skip the connection with a short reason.

Otherwise write a short message from the Candidate to the connection, asking for a referral:

- Greet the connection by first name and say the Candidate is applying to the company, naming the first role (or two, when several are listed).
- Ask whether they would be comfortable referring the Candidate, or sharing a word on the team; for a recruiter, ask whether they are the right person or could point the Candidate to the hiring team.
- Include the first role's apply URL, so they can find it, and end with thanks.
- Keep it to three or four plain, warm sentences, 600 characters at most.
- Write only what you know: never invent shared history, mutual friends, or facts about the Candidate or the connection, and leave no placeholders such as "[your name]"; the Candidate sends it from their own account, so it needs no signature.

Record every call, so the next Refresh does not ask again.
Read `.job-app-assist/refresh/referral-drafts.json` if it exists, add an entry per connection under the company's `key` and the connection's name exactly as listed, and save the whole file with the Write tool:

```json
{
  "<company key>": {
    "<connection name>": { "message": "<the Referral Draft>" },
    "<another connection name>": { "skip": "<why this connection is not at the company>" }
  }
}
```

Connections beyond the listed ones come up on a later Refresh.
This step only writes drafts: never send a message, never open LinkedIn, and never look connections up on the web (hard rules 2 and 3).

## 8. Rebuild with your calls

When step 6 or step 7 recorded anything, rebuild without the network, which applies the Resume Variant decisions and turns the recorded messages into Referral Drafts:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh --rerun
```

Use the summary it prints from here on.

## 9. Write the Job List to the dashboard

Read `.job-app-assist/refresh/out/writes.json`.
It holds `{ "batches": [[...], ...] }`.
For each batch, in order, call `ArtifactData` with `action: "batch"`, the dashboard `url`, and that batch as `writes`, exactly as listed: every entry already carries its `file_path` and, for documents that exist, its `if_version`.

- If a batch is refused because a document changed since step 4, another Refresh is writing at the same time: go back to step 4 once; the calls you recorded in steps 6 and 7 are kept.
- If the database reports it is full (`quota_exceeded`), stop writing and follow "When the dashboard storage is full" in the hard rules.

Then read `postings/meta` with `action: "get"` and check that its `refreshedAt` is the one in `.job-app-assist/refresh/out/summary.json`.

## 10. Move cards from Gmail

Hard rule 8 holds throughout: only search and read the Candidate's Gmail.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs gmail plan .job-app-assist/refresh
```

It says whether the Candidate opted in to Gmail tracking, gives the Gmail searches that cover every open card, and lists the Submitted cards with no reply in 14 days or more; keep that list for the summary.

- When it says to skip reading Gmail, go on to step 11.
- When this session has no Gmail tools from the Candidate's claude.ai Gmail connector (such as `search_threads`), Gmail is not connected: go on to step 11, and say in the summary how to connect it (claude.ai, Settings, Connectors, Gmail).
- When there is nothing to search for, go on to step 11.

### Search Gmail

Run each listed query with the Gmail connector's search tool, reading every page of results.
For each message in the threads found, note its Gmail message id, its sender (the From header, as given), when it arrived (ISO 8601 UTC), its subject and the short snippet Gmail gives.
Leave out messages the Candidate sent.
Open a thread only when the search results lack a message's sender, date or subject.
Use the Write tool to save the emails to `.job-app-assist/refresh/out/gmail-gathered.json`:

```json
{
  "emails": [
    {
      "id": "<Gmail message id>",
      "from": "Acme Recruiting <jobs@acme.com>",
      "receivedAt": "2026-11-09T14:02:00Z",
      "subject": "Your interview with Acme",
      "snippet": "Hi Sam, thanks for applying. We'd like to schedule..."
    }
  ]
}
```

The file stays in the Candidate folder, so it may hold snippets; never copy a whole email body into it.

### Match emails to cards

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs gmail match .job-app-assist/refresh
```

It classifies each email (confirmation, assessment, interview, offer or rejection), matches it to a card by company, and moves the card forward when both are clear: a confirmation to Submitted, an assessment or interview to Interviewing, an offer to Offer and a rejection to Closed.
An email never moves a card backward, and an email that moved a card once, even a move the Candidate undid, never moves a card again.
If it lists problems with the emails file, fix those entries and run it again.

### Judge unsure emails

When it reports unsure emails, read `.job-app-assist/refresh/out/gmail-review.json`.
Each entry holds the email's `emailId`, sender, date, subject and snippet, the `kinds` the rules saw, `why` the rules were unsure, and the `cards` it could be about.
For each, decide which card it is about and what kind of email it is, judging from the sender, subject and snippet; you may read the thread with the Gmail connector when the snippet says too little.

- A confirmation thanks the Candidate for applying; an assessment asks them to take an online test or take-home; an interview invites them to talk, at any round; an offer offers them the job; a rejection says the company will not move forward.
- An email that only reschedules, follows up on, or answers a question about a step the card already shows changes nothing; so does a job alert, a newsletter, a recruiter reaching out about a different role, or an email about an application with no card.
- When you cannot tell, leave it out: a wrong move costs the Candidate more than a missed one.

Record every decision so the next Refresh does not ask again.
Read `.job-app-assist/refresh/gmail-judgments.json` if it exists, add one entry per reviewed email, and save the whole file with the Write tool:

```json
{
  "<emailId>": { "postingId": "<a postingId from that entry's cards>", "kind": "interview" },
  "<another emailId>": { "ignore": true }
}
```

`kind` is one of `confirmation`, `assessment`, `interview`, `offer` or `rejection`.
Then run `jaa gmail match` again and use the summary it prints from here on.

### Write the moves to the dashboard

When `jaa gmail match` says there is nothing to write, go on to step 11.
Otherwise send each batch in `.job-app-assist/refresh/out/gmail-writes.json` with `ArtifactData`, `action: "batch"`, exactly as listed, the same way as step 9.
If a batch is refused because a card changed since step 4, the Candidate moved it meanwhile: read that card again with `action: "get"` and `out_dir` set to the absolute path of `.job-app-assist/refresh/state`, save its new version in `versions.json`, run `jaa gmail match` again, and send the new batches.

## 11. Build the News Digest

The digest has four sections.
Hiring signals come from the Job List and are computed for you; you gather the other three in chat with web search and page reads.
Every item links to its source, and the dashboard page reads nothing from the web itself.

### Plan it

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs news plan .job-app-assist/refresh
```

It reads the forums' threads for the day, then prints the digest's day, the hiring signals, the companies in the Queue, how each forum read went, and how many sources the past week's digests already linked.
`.job-app-assist/refresh/out/news-plan.json` holds the same, with the threads under `forums` and the already-linked sources under `recentUrls`; never link one of those again.

### Gather the news

Hard rule 3 holds here: never open, search or link Blind or LinkedIn, even when the Candidate asks; offer the forums below instead.
The News tab never carries a Blind or LinkedIn link you found or built yourself, search links included; a LinkedIn search link goes to the Candidate in chat or in a Research Brief, for them to click.
When the Candidate asks for Blind or LinkedIn posts, decline, offer what the digest covers instead (forum highlights from r/csMajors, r/cscareerquestions and Hacker News, and news coverage of the companies they named), and tell them they can check those sites themselves.
Pass `blocked_domains: ["teamblind.com", "linkedin.com"]` on every `WebSearch`, since searches otherwise return their posts.
Write every summary in your own words, in a sentence or two, without quoting.

- **Forum highlights**, 2 to 4 per forum: what candidates are discussing about the job market, applications, interviews, offers, layoffs and tools.
  Pick them from the threads under `forums` in `news-plan.json`: the day's top threads on r/csMajors and r/cscareerquestions, and the Hacker News front page.
  Your web tools cannot reach Reddit, so write a Reddit thread's summary from its title and excerpt; for a Hacker News thread you may read its `url` with `WebFetch` to see what the comments say.
  On Hacker News keep only stories that matter to an entry-level candidate, such as hiring, layoffs, AI tools, interviews, or a new "Ask HN: Who is hiring?" thread.
  Link the thread `url` exactly as the plan gives it, never the article a thread links to.
  For a forum the plan marks FAILED, add a gap naming it instead of searching elsewhere for it.
- **Company news**, only for the companies the plan lists under Queue: for each, search the web for layoffs, hiring freezes, hiring pushes, funding and acquisitions from the past 30 days.
  Keep only real news from a named publisher, at most two items per company, and nothing for a company with no news.
  When the plan lists no companies, leave the section empty.
- **Industry news**, 5 to 8 stories from the past few days across three topics: AI and LLMs, big tech moves, and the entry-level market.
  Cover every topic when there is news for it.
  Give each a `whyItMatters` line written for this Candidate: what it changes for their applications, or what an interviewer may ask about it.

When a section or forum cannot be read, say so in `gaps` instead of leaving it silently empty, for example `{ "section": "forumHighlights", "note": "Reddit could not be read today, so r/csMajors and r/cscareerquestions are missing." }`.

Use the Write tool to save the news as `.job-app-assist/refresh/out/news-gathered.json`, in this shape (days are `YYYY-MM-DD`):

```json
{
  "forumHighlights": [
    {
      "forum": "r/csMajors",
      "title": "...",
      "summary": "...",
      "url": "https://www.reddit.com/r/csMajors/comments/..."
    }
  ],
  "companyNews": [
    {
      "company": "...",
      "kind": "layoffs",
      "headline": "...",
      "summary": "...",
      "url": "https://...",
      "source": "Reuters",
      "publishedOn": "2026-11-09"
    }
  ],
  "industryNews": [
    {
      "topic": "ai",
      "headline": "...",
      "summary": "...",
      "whyItMatters": "...",
      "url": "https://...",
      "source": "The Verge",
      "publishedOn": "2026-11-09"
    }
  ],
  "gaps": []
}
```

`forum` is one of `r/csMajors`, `r/cscareerquestions` or `Hacker News`.
`kind` is one of `layoffs`, `hiring_freeze`, `hiring`, `funding`, `acquisition` or `other`.
`topic` is one of `ai`, `big_tech` or `entry_level_market`.

### Write it to the dashboard

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs news build .job-app-assist/refresh
```

It joins the hiring signals with your news, checks the digest against the dashboard contract, and writes `.job-app-assist/refresh/out/news-writes.json`.
If it lists problems, fix those entries in `news-gathered.json` and run it again.
Then send each batch in `news-writes.json` with `ArtifactData`, `action: "batch"`, exactly as listed, the same way as step 9.
The batch sets the day's digest (a second Refresh on the same day replaces it) and removes digests older than 90 days.
If the news cannot be written, say so in the summary; the Job List is already saved.

## 12. Prepare Applications

Queued Postings without a Prepared Application get one now, so the Candidate can review the answers before Fill.
This step comes last because `jaa refresh` clears `.job-app-assist/refresh/out/`, and because the briefs reuse the company news you just gathered.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs prepare plan .job-app-assist/refresh
```

It reads each queued Greenhouse form's free-text questions from Greenhouse's public API, without opening the form, and saves the plan in `.job-app-assist/refresh/out/prepare-plan.json`.
Postings on other sites, whose questions cannot be read ahead, are listed for Fill to prepare from the live form.
If it says there is no Style Guide or it has no tone, skip this step and tell the Candidate in the summary that `/job-app-assist:setup` writes their Style Guide, which AI-drafted answers need.
When it lists Postings to write, invoke the `job-app-assist:prepare` skill to draft their answers and Research Briefs, then build them:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs prepare build .job-app-assist/refresh
```

If it lists problems (a phrase the Style Guide avoids, a question left unanswered, a news link that is not https), fix those answers files and run it again.
Send each batch in `.job-app-assist/refresh/out/application-writes.json` with `ArtifactData`, `action: "batch"`, exactly as listed, the same way as step 9.
If the answers cannot be written, say so in the summary; Fill prepares any queued card that still has none.

## 13. Summarize in chat

Finish with a short summary built from the `jaa refresh` output, in plain words:

- how many Postings are in the Job List, how many per Location Tier, and how many are new since the last Refresh;
- the Queue: how many Postings it holds against the daily target, how many were pre-queued now and how many carried over;
- Queue items that may have closed (queued five or more days ago, or no longer in the Job List), so the Candidate applies soon or unticks them;
- how many Postings got each Resume Variant, how many unsure picks you reviewed and how many you changed, and that the Candidate can change any Posting's Resume Variant in its detail drawer;
- when the summary has a "Referral Drafts" line: how many drafts there are and at which companies, that they are in each queued Posting's drawer with a copy button, and that the Candidate sends each one themselves;
- the top three to five Postings, each as company, title, location and a link to its apply URL;
- Gmail tracking: each card an email moved, as company, title, the Stage it moved to, and the email's subject and date, plus how many unsure emails you judged; remind the Candidate that dragging a card back undoes a move.
  When Gmail was skipped, say why in one line: tracking is off or not chosen yet (they can run `/job-app-assist:setup` to switch it on), or Gmail is not connected (how to connect it);
- Submitted cards with no reply in 14 days or more, from the last `jaa gmail` output, so the Candidate can send a short follow-up themselves;
- the News Digest: the biggest hiring signal and one or two headlines worth reading, plus any gap `jaa news build` reported;
- Prepared Applications: how many Postings got answers, how many answers are left for the Candidate to write from a Research Brief, that they review and edit them in each queued Posting's drawer, and how many Postings Fill will prepare from the form instead;
- every failing Source, said plainly: which Source (or which watchlist company), what went wrong, and that today's Job List may be incomplete because of it;
- Postings the Candidate added by URL that were left out, and why, so they can fix the details in the Sources panel or tune their Search Profile;
- Source documents the summary says do not match the dashboard contract, with a suggestion to switch that Source off and on again in the Sources panel;
- Location Tier entries that matched no Posting location, if any, with a suggestion to reword them by rerunning `/job-app-assist:setup`;
- links to the dashboard's Postings, Progress and News tabs (the dashboard `url` followed by `#postings`, `#progress` or `#news`).

Keep it to a few lines; the dashboard holds the detail.
