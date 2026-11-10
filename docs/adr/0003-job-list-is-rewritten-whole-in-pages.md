# The Job List is rewritten whole, in a few page documents

Refresh stores the Job List as one `postings/meta` document plus up to five `postings/page-N` documents of 200 ranked Postings each, and rewrites all of them on every Refresh in one ArtifactData batch.
It does not store one document per Posting.
The ranking changes every day (freshness decays, new Postings push others down), so a document per Posting would mean hundreds of writes per Refresh, each one passing through the Candidate's Claude and costing plan usage.
Pages keep a Refresh to a handful of writes whose content goes from file to database without passing through the conversation, and a single batch makes the update all or nothing.

## Considered Options

- One document per Posting: natural to address, but hundreds of writes and tokens per Refresh, and the page would see a half-updated Job List while Refresh is writing.
- One document for the whole Job List: simplest, but a large Job List would pass the 256 KB document limit.

## Consequences

- The Job List is capped at 1,000 Postings, the best-ranked ones; the meta document records how many matched in total.
- Each page carries the `refreshedAt` of the Refresh that wrote it, and the page shows a Job List only when every page matches the meta document, so a Refresh interrupted part way never shows a mixed list.
- Only Refresh writes to `postings`. The Candidate's own choices about a Posting (Queue, skips, Resume Variant overrides) live in other collections and refer to the Posting by its id, a hash of its apply URL that stays the same across Refreshes.
