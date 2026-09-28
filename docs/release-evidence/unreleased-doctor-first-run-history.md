# Unreleased: a first doctor in a new project

## What was measured

On ACC 0.8.1, `acc doctor` against a data home with no store for the project printed
`store healthy (history from undefined); 0 live; …`. Found on 2026-09-27 during the live capture
for #213 and #214, with a fresh isolated data home. Doctor builds its own report when
`protocol.json` does not exist yet, and that report had no `trimmedThrough`; the summary compares
the field with `null`, so `undefined` was printed. It has done so since the history trim landed
(`1afde58`, 2026-09-24).

## What changed

`packages/cli/src/doctor-command.mjs`: the report for a store not yet created has the storage
report's full shape - `swept`, `staged`, `partials` and `retired` at 0 and
`trimmedThrough: null`.

## Tests

`tests/process/doctor-reports.test.mjs` gains "a first doctor in a new project says nothing about
a history it does not have": the first line starts `store healthy; `, the text contains no
`undefined`, and `--json` reports `store.trimmedThrough` as `null`. It failed on the
unchanged code with the measured line, and removing `trimmedThrough: null` fails it again.
The existing test that ran doctor on a fresh data home matched only `/store healthy/`.

## Suite

`npm test` on the evidence commit `75dfe4f`: 2,647 tests, 2,646 passing, 0 failing, 1 skipped.
The skipped test is the existing uninstall check that skips on a machine where Gemini CLI is
installed, as on `main`. Nothing was re-run.

## Exact local artifact

- Source: clean commit `159e6948ae8a27617adba0b397cfd148136ef038` on
  `fix/doctor-first-run-history`, over `main` at `259fdc3`.
- Archive: `agents-can-communicate-0.8.1.tgz`, packed from that commit.
- Size: 474,017 bytes; 311 packed entries.
- SHA-256: `fc93d86c2a3d3efb3220f56874d148778986212dc56bfe3803209f069df122a1`.
- Package version remains `0.8.1`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
