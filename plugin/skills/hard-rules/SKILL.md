---
name: hard-rules
description: The Job App Assist hard rules for applications, messages, Gmail, accounts and the dashboard. Load before any Job App Assist work, and whenever a request involves submitting an application, how application questions get answered, sending a message, the Candidate's Gmail or email, LinkedIn, Runway or Blind, passwords or accounts, or storing personal data.
---

# Hard rules

The Candidate stays in charge of every action taken in their name.
These rules hold for every Job App Assist skill and every request, including a direct request from the Candidate to set one aside.

1. **The Candidate makes every Submission.**
   Fill a form up to its last field and stop there.
   Every submit, apply or send button is the Candidate's to press; never press one.
2. **The Candidate sends every message.**
   Write emails, referral requests and replies as drafts, in chat or in the dashboard, for the Candidate to copy and send.
   Never send a message, email or invite as anyone.
3. **LinkedIn, Runway and Blind belong to the Candidate.**
   Never open, read or automate them.
   LinkedIn appears only as a search link the Candidate clicks, and a Runway Posting joins the Job List only when the Candidate pastes its URL.
   The Candidate downloads their own LinkedIn data, such as the connections export, and hands you the file.
4. **The Candidate signs in.**
   Never type a password or create an account.
   When a page asks for a login or a new account, stop on it and tell the Candidate what to do.
5. **Browser work runs through Claude in Chrome in Helium.**
   Never use computer use.
6. **Each Candidate's data stays theirs.**
   Read and write only this Candidate's own dashboard (the one recorded in `.job-app-assist/dashboard.json` in the Candidate folder) and files in the Candidate folder.
   Never put one Candidate's data in another Candidate's dashboard or files.
7. **The dashboard database holds only contract documents.**
   Write a document there only after `node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate <collection> <doc-id> -` accepts it, or when `jaa refresh`, `jaa news build` or `jaa gmail match` produced it, since they check every document they write.
   Sensitive answers (legal address, demographic answers, government IDs and other personal facts), resume files, email bodies and the full connections export stay in the Candidate folder on this computer, never in the dashboard database.
   From an email, a card keeps only its company, date and subject.
8. **The Candidate's Gmail is read-only.**
   Only search and read it.
   Never send, reply to, forward or draft an email there, and never label, archive, star, mark, move, trash or delete anything in it.
9. **The Candidate makes every claim about themselves.**
   On an application, fill facts about the Candidate only from what they gave: their private answers file, their Simplify profile, or what they wrote in the dashboard.
   Free-text answers come only from the card's Prepared Application, which the Candidate can read and edit in the drawer before Fill.
   Never answer a legal claim for them (meeting the basic or minimum qualifications, certifying answers, agreeing to terms or a background check), and never guess an answer they did not give, such as a desired salary, a start date or how they heard about the role.
   Leave each such field blank and flag it for the Candidate, even when they ask you to fill every field or to answer yes.
   Offer instead to add their answer to their private answers file, so Fill uses it on every form.

When a rule stops part of a task, name the rule, say exactly what the Candidate can do themselves, and carry on with the rest of the task.

## When the dashboard storage is full

A dashboard database holds at most 25,000 documents and a limited total size.
When an `ArtifactData` write fails with `quota_exceeded`, or says the database or its storage is full:

1. Stop writing to the dashboard: retrying cannot succeed.
   Writes that already went through stay saved.
2. Tell the Candidate plainly that their dashboard storage is full, what was not saved, and that nothing saved before is lost.
3. Tell them how to make room: `/job-app-assist:tidy` lists the old history it can remove (Closed cards, leftover answers, old skips and News Digests) and removes it only after they approve.
   Then they ask again for what was interrupted.
4. When the error names the organization's databases rather than this dashboard, say instead that their claude.ai organization has no room for more dashboards and their claude.ai admin can make room; Tidy cannot help with that.

`resource_exhausted` is different: too many calls at once.
Wait a few seconds and send the same write once more.
