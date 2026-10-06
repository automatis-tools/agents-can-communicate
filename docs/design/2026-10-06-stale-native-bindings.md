# Bindings without a client pid and a store-contract update

Date: 2026-10-06. Issue #273. Ships in 0.10.1.

## Problem

An update that changes the store contract activates only when no live process holds the
older contract. A native session binding that names no client process could not be judged:
`listNativeHolds` counted it as a live client until a lifecycle cleanup that never comes for a
session that crashed or was written by an older release. Retention runs only on `acc prune
--apply`, and when it removes such a session it keeps the binding.

On the maintainer's Mac, 0.10.0 (contract 7) stayed pending behind 32 of them: 26 named
sessions that retention had removed, 6 named sessions whose recorded process had exited.
Releases 0.5.10 to 0.9.0 wrote them. Closing every client could not clear them.

The activation decision is not always this release's code. `acc update` and `acc doctor` run
the newest installed generation, so the pending one. The automatic update runs in the active
(older) generation's worker, which imports the pending generation's `prepareRefresh` and only
then lists blockers by its own rule.

## Decision

- **A binding without a client pid is judged by its session record.** It stops holding when
  the record is gone, when the record names a process that has exited, or, with no process
  recorded, when ACC's presence rule calls the session offline: closed, or 30 minutes without
  a heartbeat - the rule retention removes sessions by. A live recorded process, a record that
  cannot be read, or a missing store keeps the binding a hold.
- **`prepareRefresh` removes those bindings**, so an older activator, which still counts them,
  finds them gone. A binding whose file changed between the judgement and the removal stays.
- A session that names a live process keeps its binding a hold, whatever its presence says.

## Why this is safe for the store

The rule is the one retention removes sessions by. A client process that is idle past it and
wakes later runs its next hook through the launcher, which admits it under the active
generation with a runtime lease; a hook that runs during the migration holds a lease and
blocks it. No client runs ACC's store code in its own
process, so a binding is evidence of a client, not of a writer.

## Not changed

- Bindings that name a client pid hold until that process exits, as before.
- MCP continuity records stay exempt only when validated.
- Retention itself does not remove bindings; the rule makes them harmless instead.

## Verification

- Unit: a binding without a pid stops holding for a removed session, an exited process, a
  closed session and a quiet one, and keeps holding for a heartbeating session without a pid
  and for a live process; the sweep removes only the stale ones; `prepareRefresh` removes them.
- A copy of the maintainer's data home: 32 bindings without a pid blocked 0.10.0; with the
  rule, none does, and the 8 that remain name live client processes.
- Upgrade: the published 0.9.1, with such bindings, updates to the candidate through its own
  updater, and the candidate activates.
