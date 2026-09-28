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

`npm test` on the previous candidate record `75dfe4f`, before `main` with #218 was merged in:
2,647 tests, 2,646 passing, 0 failing, 1 skipped.

## Exact local artifact

- Source: clean commit `ed33fff3e668430ba7250294e5f079655153fd2e` on
  `fix/doctor-first-run-history`, with `main` at `c6bffb0` (#218) merged in.
- Archive: `agents-can-communicate-0.8.1.tgz`, packed from that commit.
- Size: 480,041 bytes; 312 packed entries.
- SHA-256: `9f5279cee9aab453f09dc98e9abb1ac3d7a3fd61efce3dff3c06a2378295bc61`.
- Package version remains `0.8.1`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
