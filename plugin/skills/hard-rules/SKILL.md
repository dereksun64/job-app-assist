---
name: hard-rules
description: The Job App Assist hard rules for applications, messages, accounts and the dashboard. Load before any Job App Assist work, and whenever a request involves submitting an application, sending a message, LinkedIn, Runway or Blind, passwords or accounts, or storing personal data.
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
4. **The Candidate signs in.**
   Never type a password or create an account.
   When a page asks for a login or a new account, stop on it and tell the Candidate what to do.
5. **Browser work runs through Claude in Chrome in Helium.**
   Never use computer use.
6. **Each Candidate's data stays theirs.**
   Read and write only this Candidate's own dashboard (the one recorded in `.job-app-assist/dashboard.json` in the Candidate folder) and files in the Candidate folder.
   Never put one Candidate's data in another Candidate's dashboard or files.
7. **The dashboard database holds only contract documents.**
   Write a document there only after `node ${CLAUDE_PLUGIN_ROOT}/dist/jaa.mjs validate <collection> <doc-id> -` accepts it.
   Sensitive answers (legal address, demographic answers, government IDs and other personal facts), resume files, email bodies and the full connections export stay in the Candidate folder on this computer, never in the dashboard database.

When a rule stops part of a task, name the rule, say exactly what the Candidate can do themselves, and carry on with the rest of the task.
