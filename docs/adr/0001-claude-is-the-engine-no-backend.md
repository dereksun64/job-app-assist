# Claude is the engine; there is no backend

The toolkit has no server, database or scripted form filler of its own.
Each Candidate's own Claude does the work, guided by a Claude Code plugin (skills plus hard rules), run from the Code tab of the Claude desktop app, and each Candidate's dashboard is a claude.ai Artifact in their own account, with its data in the Artifact's database.
We chose this so anyone can use the toolkit without installing or hosting anything, so no one person holds friends' personal data, and so Claude can handle any application site without per-site code.

## Considered Options

- A hosted web app with sign-in: robust and multi-device, but it makes the maintainer responsible for everyone's resumes and personal answers.
- A local web app per Candidate: private, but non-technical friends can't install and run it.
- Scripted fillers for Greenhouse, Lever and Ashby: fast and cheap per application, but brittle, and they cover only part of the postings.

## Consequences

- Dashboard design updates reach Candidates by republishing their Artifact page; their data survives because it lives in the Artifact database, not the page.
- The cost of the work is each Candidate's Claude plan usage, not API billing.
