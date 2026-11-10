# All Claude work starts from chat; the dashboard only shows and collects

Refresh and Fill both start when the Candidate asks their Claude in chat ("refresh", "fill my queue"), not from buttons on the dashboard.
An Artifact page cannot drive Claude in Chrome, and its own reach is narrow: it can call Claude without web access and a few connectors, so news gathering from a page would be partial.
A Claude Code session has the full toolset (web search, page fetching, Gmail, Claude in Chrome in Helium with Simplify), so it does all the work and writes the results into the dashboard's database.
The dashboard is then only a view plus the Candidate's own inputs (queue choices, skips, edits, settings), which keeps all behavior in one place: the plugin's skills.

## Considered Options

- A Refresh button running inside the page: one click, but news limited to the few sources a page can reach, and the ranking and Gmail logic would live in page code, apart from the skills.
- A short news digest from the button plus a full digest from chat: two code paths producing two digests, for little gain.
- Fill from the page through the Claude app's built-in browser: no Simplify (so more tokens), untested, and the Candidate would submit inside the Claude app instead of Helium.
- Running on a schedule overnight: rejected because the Candidate wants everything on demand, and tabs left open for hours risk being discarded or logged out.

## Consequences

- Filling uses Claude in Chrome, never computer use, so it runs in Helium tabs without taking over the screen.
- The dashboard needs only its database; it calls no connectors and no Claude from the page.
- Progress reaches the dashboard as Claude writes each Posting's Stage and each Refresh's results to the database.
