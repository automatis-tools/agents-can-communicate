# Unreleased: bindings that name no client stop keeping a store-contract update pending

| Candidate artifact | Value |
|---|---|
| Built from | `5daba112191e99cc089e29c8e7c7d7ec7ad3809d` |
| Tarball | `agents-can-communicate-0.10.0.tgz`, 578,928 bytes, 351 files |
| sha256 | `83833715f069c701d17a7ad02ef5e9af39c3ac1c7a98ca90207b69f332293643` |

Issue: #273. Design: [2026-10-06-stale-native-bindings](../design/2026-10-06-stale-native-bindings.md).

## What was measured before the change

On the maintainer's Mac, right after 0.10.0 was published (2026-10-06), `acc update` from
0.9.1 staged 0.10.0 and reported `waiting for 37 active or unidentified process(es)`: 5 live
client processes and 32 `unidentified process (native; 1 native binding; store contract 6;
unknown client pid)`. Of the 32 bindings, 26 named sessions with no record left and 6 named
open sessions whose recorded process had exited. 27 were written by 0.8.5, 2 by 0.9.0, 2 by
0.8.0 and 1 by 0.5.10.

## What changed

- `cli/managed-runtime/activation.mjs`: `listNativeHolds` judges a binding without a client pid
  by its session record. It is no hold when the record is gone, names an exited process, or,
  with no process recorded, is offline by `classifySessionPresence` (closed, or 30 minutes
  without a heartbeat). A live recorded process, an unreadable record or a missing store keeps
  it a hold. `sweepStaleBindings` removes exactly those bindings, and leaves a file that
  changed since it was judged.
- `cli/managed-runtime/refresh.mjs`: `prepareRefresh` calls `sweepStaleBindings` first. An
  older generation's activator imports the pending generation's `prepareRefresh` before it lists
  blockers by its own rule.

## Tests

- New `managed-runtime-stale-bindings.test.mjs`: a binding without a pid stops holding for a
  removed session, an exited process, a closed session and a quiet one; it keeps holding for a
  heartbeating session without a pid and for a live process; the sweep removes only the stale
  ones; `prepareRefresh` removes them. Four of these failed before the change.
- `managed-runtime-activation.test.mjs`: an MCP-shaped binding whose owner session is gone no
  longer holds (it was one of the "misleading" cases); the fixture session heartbeats on the
  real clock, so the other cases still test the continuity exemption.

## Upgrade from the published 0.9.1

The published `agents-can-communicate@0.9.1` was installed in isolation with a contract-6 store
and two bindings without a pid that name sessions with no record. A local registry served an
archive of this tree with its version set to 0.10.1.

- The published 0.10.0 in its place, as a control: `acc update` printed `ACC 0.10.0 is ready;
  waiting for 2 active or unidentified process(es)`, both `unknown client pid`. The store stayed
  on contract 6 and both bindings stayed.
- This tree: `acc update` printed `Updated ACC to 0.10.1; integrations refreshed.` The 0.9.1
  updater activated it by its own rule, after the candidate's `prepareRefresh` had removed both
  bindings. The store moved to contract 7, and doctor reported `ACC 0.10.1 is active.`
- This tree with a third binding without a pid, for an open session that was still
  heartbeating: the two stale bindings were removed, the third stayed and kept the update
  pending, and the store stayed on contract 6.

## A copy of the maintainer's data home

Native holds that block a contract-7 activation, counted read-only on the backup taken before
the 0.10.0 update:

| Code | Blocking bindings | Without a pid | With a live pid |
|---|---|---|---|
| 0.10.0 | 40 | 32 | 8 |
| this tree | 8 | 0 | 8 |

The one binding left without a pid after the first change of this tree named an Antigravity
session with no recorded process and no heartbeat since 2026-10-05; retention had not run, so
the presence rule was added.
