---
name: refresh
description: Refresh the Candidate's Job List, Queue and News Digest. Pulls Postings from the Candidate's enabled Sources (the Job Feed, their watchlist companies' job boards and Postings they added by URL), keeps the ones that match the Search Profile, ranks them, picks a Resume Variant for each, pre-queues the best ones up to the daily Queue target, writes them to the dashboard's Postings tab, builds the day's News Digest for the News tab and ends with a short summary in chat. Use when the Candidate asks to refresh, update their jobs, see today's Postings or catch up on the news.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh --rerun) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs news plan .job-app-assist/refresh) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs news build .job-app-assist/refresh) WebSearch WebFetch(domain:news.ycombinator.com) Bash(rm -rf .job-app-assist/refresh/state .job-app-assist/refresh/out) Bash(mkdir -p .job-app-assist/refresh) Bash(cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html)
---

# Refresh

Refresh rebuilds the Candidate's Job List: every Posting from their Sources that matches their Search Profile, ranked best first, on the Postings tab of their dashboard.
It then tops up the Queue: the best-ranked Postings are pre-queued until the Queue holds the daily Queue target, higher Location Tiers first.
Unsubmitted Queue items carry over and count toward the target, and a Posting the Candidate skipped is never pre-queued again.
Last, it builds the day's News Digest on the News tab: hiring signals from the Job List, forum highlights, news about companies in the Queue, and 5 to 8 industry stories.
The ranking, filtering, dedupe, Resume Variant picks and pre-queueing happen in `jaa refresh`, a deterministic program, and `jaa news` computes the hiring signals; your part is to hand them the dashboard state, review the picks `jaa refresh` is unsure about, gather the news in chat, apply what they produce, and tell the Candidate what changed.
The current working directory is the Candidate folder.

## 1. Load the hard rules

Invoke the `job-app-assist:hard-rules` skill before anything else and follow it throughout.

## 2. Find the dashboard

Read `.job-app-assist/dashboard.json`.
It holds `{ "url": "<dashboard Artifact URL>", "pageVersion": "<version>" }`.
If it does not exist, tell the Candidate that Refresh needs their dashboard first, ask them to run `/job-app-assist:setup`, and stop.

## 3. Bring the dashboard page up to date

Read `version` from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
When it differs from `pageVersion`, the Toolkit has a newer dashboard page:

```bash
cp ${CLAUDE_PLUGIN_ROOT}/dist/dashboard.html .job-app-assist/dashboard.html
```

Read the dashboard `url` with the `Artifact` tool, then publish `.job-app-assist/dashboard.html` to that `url` without passing `capabilities`, so the page keeps its database and its data.
Then save `pageVersion` in `.job-app-assist/dashboard.json` as the new version.
If the publish fails, say so in the summary and carry on; the data still updates.

## 4. Save the dashboard state

Start from a clean state folder:

```bash
rm -rf .job-app-assist/refresh/state .job-app-assist/refresh/out
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

Each read reports a `version` for every document.
Use the Write tool to save `.job-app-assist/refresh/versions.json` mapping each postings and news document you read to its version, for example `{ "postings/meta": 4, "postings/page-1": 4, "news/2026-11-09": 1 }`, or `{}` when there were none.
Cards and skips need no versions: Refresh only creates new cards and never changes a card or skip that exists.
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
Then rebuild without the network, which applies the decisions:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs refresh .job-app-assist/refresh --rerun
```

Use the summary it prints from here on.
Unsure picks beyond the listed ones keep their pick and come up again on a later Refresh.

## 7. Write the Job List to the dashboard

Read `.job-app-assist/refresh/out/writes.json`.
It holds `{ "batches": [[...], ...] }`.
For each batch, in order, call `ArtifactData` with `action: "batch"`, the dashboard `url`, and that batch as `writes`, exactly as listed: every entry already carries its `file_path` and, for documents that exist, its `if_version`.

- If a batch is refused because a document changed since step 4, another Refresh is writing at the same time: go back to step 4 once.
- If the database reports it is full or over quota, stop and tell the Candidate plainly that their dashboard storage is full.

Then read `postings/meta` with `action: "get"` and check that its `refreshedAt` is the one in `.job-app-assist/refresh/out/summary.json`.

## 8. Build the News Digest

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
Then send each batch in `news-writes.json` with `ArtifactData`, `action: "batch"`, exactly as listed, the same way as step 7.
The batch sets the day's digest (a second Refresh on the same day replaces it) and removes digests older than 90 days.
If the news cannot be written, say so in the summary; the Job List is already saved.

## 9. Summarize in chat

Finish with a short summary built from the `jaa refresh` output, in plain words:

- how many Postings are in the Job List, how many per Location Tier, and how many are new since the last Refresh;
- the Queue: how many Postings it holds against the daily target, how many were pre-queued now and how many carried over;
- Queue items that may have closed (queued five or more days ago, or no longer in the Job List), so the Candidate applies soon or unticks them;
- how many Postings got each Resume Variant, how many unsure picks you reviewed and how many you changed, and that the Candidate can change any Posting's Resume Variant in its detail drawer;
- the top three to five Postings, each as company, title, location and a link to its apply URL;
- the News Digest: the biggest hiring signal and one or two headlines worth reading, plus any gap `jaa news build` reported;
- every failing Source, said plainly: which Source (or which watchlist company), what went wrong, and that today's Job List may be incomplete because of it;
- Postings the Candidate added by URL that were left out, and why, so they can fix the details in the Sources panel or tune their Search Profile;
- Source documents the summary says do not match the dashboard contract, with a suggestion to switch that Source off and on again in the Sources panel;
- Location Tier entries that matched no Posting location, if any, with a suggestion to reword them by rerunning `/job-app-assist:setup`;
- links to the dashboard's Postings tab and News tab (the dashboard `url` followed by `#postings` or `#news`).

Keep it to a few lines; the dashboard holds the detail.
