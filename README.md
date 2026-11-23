[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lively-wren-88-6565/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lively-wren-88-6565/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

Built for [make.fun's "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) ($100 in USDC).

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats,
and `mend` reads all four to one specification (`SPEC.md`): a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the lines an edit
names even when the model drifted their whitespace or indentation, and changes every file or none.

Node 22 and its standard library alone; nothing is installed.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When absent or `-`,
  the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or `json`; `auto` (the default)
  detects it.
- `--check` does everything but write: the same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, `R old -> new` for a move) and `ok: <n> files`.
Exit 1 prints one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`, and writes
nothing. Exit 2 prints one usage, no-patch, format or parse error line. See `SPEC.md` for the whole contract.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the trial runner (kept as the kit has it). In a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts the exit code, stdout and files left behind.
- `check.ts`: run the practice set on your own machine (the kit carries it at
  `program/generator/practice.json`):

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Matching

Old lines are found at the first of three tiers at which they occur: exact, then ignoring trailing spaces and
tabs, then ignoring leading and trailing spaces and tabs (with added lines re-indented to the file's indent).
Unified hunks take the occurrence nearest their (possibly wrong) line number; SEARCH/REPLACE blocks fail as
ambiguous when the old lines occur more than once; V4A chunks walk a cursor through the file, anchored by `@@`
lines and `*** End of File`.
