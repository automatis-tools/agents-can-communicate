# Unreleased status stops reporting a finished intent as current work

`acc work --clear` exists so a peer stops reading work that has stopped. In a materialised
workspace it marks the intent record `state: "done"` and appends `intent.cleared`, rather than
erasing the record, so the workspace keeps what each session worked on. No reader consulted that
state. `acc status` reported the summary of a done record as the participant's current work, and
attention kept matching the record's `resourceHints` against live claims. The command and the
status contradicted each other about the same session.

An ephemeral clear deletes the record instead. A lone session therefore always read correctly,
and only a workspace shared by two or more sessions showed the defect - which is every workspace
where the answer matters.

`docs/CLI.md` already describes `status` as returning "current intent", so this aligns the code
with the documented contract. No documentation changed.

## Reproduction through the CLI

Two participants attach to a throwaway store, both publish intent, one clears it, and the next
`acc status` is read. Built from the repository, not from a tarball:

```
main @ a14bc46
  acc work --clear  ->  intent cleared
  finished: intent "reviewing the inbox"
  working:  intent "porting the claim model"

this branch
  acc work --clear  ->  intent cleared
  finished: intent null
  working:  intent "porting the claim model"
```

The session that finished its work reads as having none; the session still working is untouched.

## The same shape in a real store

Measured on a copy of the maintainer's workspace store, never on the live one. That workspace
held 45 session records and 12 intent records. Ten of the twelve intents were `done`, and one
session whose record still read `state: "open"` carried one of them. On `main` that session's
finished summary is what a peer reads as its current work.

## What still counts as current work

`state` has four values, and only `done` is finished. A `blocked` or `waiting` session has
stopped, but it still owns its work and the hints that announce it, so both continue to be
reported and continue to produce `claim_conflict` and `claim_contended`. Tests cover each of the
three, and a done intent produces neither kind.

## Exact local artifact

- Source: clean commit `15fe8e3afec79f3a8bfec2925185d7bda0b7b7bf`, which merges `main` at `6f48870`.
- Archive: `agents-can-communicate-0.6.3.tgz`, packed from that commit.
- Size: 453,539 bytes; 307 packed entries.
- SHA-256: `5e72accf5bfd1540faddbbb69ffb2a77452122ab2cea2a54384f32f62e216fab`.
- Package version remains `0.6.3`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`, including clean installation, the doctor
run, and the check that every packed Markdown link resolves inside the tarball.

`npm test` on this tree: 2,496 passing, 0 failing, 1 skipped, of 2,497.

## Limits

Three readers changed; nothing about how an intent is written changed, and no record is removed
that was kept before. The status payload keeps its shape: `intent` is still a string or `null`,
so a client reading it needs no change. Reporting *why* a session has no current intent - stopped
versus never published - is a separate outcome, proposed in issue #139 and not addressed here.
