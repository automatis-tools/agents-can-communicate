# Unreleased — a placed swap for the store symlink check

This development candidate implements #250: the required check that an ancestor
swapped for a symlink cannot serve another directory in the store no longer depends
on timing. It is not a published release. The package still declares version 0.11.0;
these candidate bytes differ from the published 0.11.0 artifact, whose original record
remains unchanged. Only tests changed; no shipped module did.

## Source and artifact

| Fact | Value |
|---|---|
| Source commit | `66d8f42cdddc46299a4a5cd5ca08a7b195a58059` |
| Source state at pack time | clean feature worktree |
| Archive | `agents-can-communicate-0.11.0.tgz` |
| Archive size | 609,126 bytes |
| Packed files | 374 |
| SHA-256 | `78625791a732a9f081638423cecec30e1009667dd2329bce01860176d5c0bef3` |
| Local environment | macOS, Node 26.5.1 |

`node scripts/verify-package.mjs` passed on the clean worktree and reported the same
digest as a separate `npm pack`. The archive's bytes equal main's at `e03124fb`: tests
are not packed, but the recorded commit covers them.
The branch also carries commit `83fd29d5`, the `waitForWorkers` fix from the module
loading branch (#296): without it the full suite on this machine can hang in
`tests/process/native-binding-reaches-the-receiver.test.mjs`.

## Cause

The check ran sixteen readers through a three-level walk while a loop swapped its
first segment for a symlink to a decoy, waited a few event-loop turns, swapped it
back, and then left a quiet window. It asserted that no walk was served the decoy,
and, to prove the race ran at all, that some walk fitted inside a quiet window. On
2026-10-01 Linux CI made 170 swaps with a 2 ms window and admitted none: the check
failed with "the race never ran" though nothing was wrong. PR #249 grew the window up
to 250 ms when no walk fitted, which made the failure rarer without removing it: the
schedule still decided whether the check proved anything.

## Change

- `assertManagedDirectory` already runs an `afterInspect` seam between a segment's
  check and its resolution, the window a rename lands in. The check now swaps the
  ancestor there at every step of the walk (after `target`, `target/l1`,
  `target/l1/l2` and `target/l1/l2/l3` are checked) and once before the walk starts.
- Each swapped walk must be refused as not a real directory, an escape from the
  canonical store root, or a parent that changed while it resolved. A walk served
  any directory fails the check, the decoy's included.
- A walk with no swap must serve the original directory, before the swaps and after
  the original is restored.
- The free-running race moves to `tests/stress/ancestor-symlink-race.mjs`, outside
  default discovery, like `tests/stress/managed-runtime-reclaim.mjs`.

## Mutation

With the walk changed to accept any resolution inside the canonical root and to skip
the identity check of a renamed leaf, the check failed: "the decoy's directory was
served for the target's path, swapped after target was checked".

## Runs

The new check passed 30 runs in a row at load average about 96 on this Mac.
