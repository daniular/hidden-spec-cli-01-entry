# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/daniular/hidden-spec-cli-01-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/daniular/hidden-spec-cli-01-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote to a tree of text files. Models write
edits in four formats, and this one CLI reads all four: unified diffs (often
with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor
tool calls as JSON. It finds the lines an edit names even when whitespace or
indentation drifted, and it changes every file or none — a failed edit leaves
the tree untouched.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, with
the patch on stdin when PATCH is absent or `-`. See `SPEC.md` for the full
rules: fuzzy matching in three tiers, atomic all-or-nothing writes, create /
delete / move, and the exact output and exit codes.

Built for the make.fun bounty "Build mend, one patch tool for every AI edit
format" (`hidden-spec-cli-01-run-20261122`). Node 22, standard library only.
