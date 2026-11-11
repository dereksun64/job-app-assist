# The built plugin files are committed

`plugin/dist/` holds the dashboard page and the `jaa` CLI, built from `src/` by `npm run build`, and it is committed to the repository.
Claude Code installs a plugin by copying its folder from the marketplace's git repository, and runs no build step, so a Candidate who installs with `claude plugin marketplace add` and `claude plugin install` gets exactly what is committed.
Committing the build means installing needs no Node.js toolchain, no `npm install`, and no network beyond GitHub, and every commit on `main` is a working Toolkit.

## Considered Options

- Build on install: impossible, since a plugin install runs no commands.
- A bot that builds and commits `plugin/dist/` after each merge to `main`: pull requests would no longer touch the generated files, but `main` would be broken between the merge and the bot's commit, a pull request branch could not be installed to test it, and the bot needs write access to `main`.
- A separate release branch or tag that holds the build, with the marketplace pointing at it: clean history on `main`, but two sources of truth, a release step to forget, and installs that lag behind merged work.

## Consequences

- Every pull request that changes `src/` also changes `plugin/dist/`, so parallel pull requests conflict there.
  The fix is mechanical: take either side, run `npm run build`, and commit; never edit the files by hand.
- CI runs `npm run check:dist`, which fails when `plugin/dist/` does not match a fresh build, so a stale build never merges.
- `.gitattributes` marks `plugin/dist/` as generated, so GitHub collapses it in pull request diffs and leaves it out of language statistics.
- The dashboard page is stamped with the plugin version, which is how skills know to republish it after an update.
