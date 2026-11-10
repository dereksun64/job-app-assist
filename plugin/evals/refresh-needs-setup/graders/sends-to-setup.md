---
type: llm
---

The Candidate folder has no `.job-app-assist/dashboard.json`, so Job App Assist has not been set up and there is no dashboard to refresh.

PASS if the final reply tells the user that a dashboard or Setup is needed first and points them to `/job-app-assist:setup` (or to setting up Job App Assist).

FAIL if the reply claims a Refresh ran, lists Postings as if they were saved to a dashboard, or invents a dashboard link.
