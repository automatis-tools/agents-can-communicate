# Unreleased — a hook reads each stored record once

This development candidate fixes #298: a hook's cost grew with the size of its
workspace, and on a busy machine or in a large workspace it passed the five-second
budget and continued without ACC's context. It is not a published release. The package
still declares version 0.11.0; these candidate bytes differ from the published 0.11.0
artifact, whose original record remains unchanged.

## Source and artifact

| Fact | Value |
|---|---|
| Source commit | `a0d76652d5162449cc5e22ab8eb4f0bd5adb4536` |
| Source state at pack time | clean feature worktree |
| Archive | `agents-can-communicate-0.11.0.tgz` |
| Archive size | 610,942 bytes |
| Packed files | 376 |
| SHA-256 | `f643015af49bd3051ba2343d685a2779c80fd66b600b2662e971558cbf4a2e21` |
| Local environment | macOS, Node 26.5.1 |

`node scripts/verify-package.mjs` passed on the clean worktree and reported the same
digest as a separate `npm pack`. The fix is commit `29ff51f0`. The recorded commit adds
test changes only: the archive's bytes are the same.

The first full suite found three tests that read or bounded the closing status without
asking for it, now passing `includeSessions: true`, and two shard tests that failed in
this checkout: `scripts/run-tests.mjs --list` exited before a pipe took more than 64 KiB
of its output, and this worktree's longer path pushed the list past it. It now finishes
writing first.

## Cause

`tests/acceptance/context-reminders-packed.test.mjs` failed three times on 2026-10-12
during full suites at load average 96–127: a real installed hook passed its budget
"while reading the status". Each hook in that test took about 200 ms at load 22.

The same hooks, run against a copy of the maintainer's data home with an isolated
`ACC_DATA_HOME` and phase timings, showed where the time went. One `beforeTurn`:

- read every message and receipt three times: `sync` read the whole store, next-turn
  delivery read messages and receipts again, and the hook closed with
  `collectStatus`, which read the whole store a third time;
- read every session for its heartbeat: the transaction declared `session` without
  loading only the one it updates;
- read each record of a kind one after another.

The closing status filled `result.sessions`, which only tests read; the hook entry
point never did. In the largest workspace, CodexBar's ClaudeProbe with 2,234 sessions
and 1,206 participants, the closing status took 2.8–4.1 s, the projection 1.1–1.35 s and
the heartbeat 0.8–1.0 s, and starts and turns timed out at load average about 10.

## Change

- `runHook` reads the closing status only when called with `includeSessions: true`.
  Tests that read `result.sessions` pass it; the hook entry point does not.
- The turn's projection reads the store once and passes that read to `sync` and to
  next-turn delivery, which accept it as `snapshot`. Nothing is written between them.
- `heartbeatSession` loads its own session as an exact transaction record.
- `listState` reads sixteen records of a kind at a time and returns them in the order
  of their file names. After a read fails, the remaining readers stop.

The store format, entry points and every hook's output to its client are unchanged.

## Measurements

The copy held the maintainer's real workspaces. Each round ran a SessionStart and two
turns for a new session, alternating main at `d052ebbd` and this change, three rounds,
at load average 10–27:

| Workspace | Records | SessionStart, main → change | Turn, main → change |
|---|---|---|---|
| agents-can-communicate | 4,760 files, 57 sessions | 0.65–1.05 s → 0.25–0.26 s | 0.96–1.05 s → 0.29–0.33 s |
| newsmill-ai | 6,432 files, 103 sessions | 0.82–0.99 s → 0.25–0.27 s | 1.10–1.30 s → 0.30–0.34 s |
| CodexBar ClaudeProbe | 15,921 files, 2,234 sessions | 2.76–3.99 s → 0.47–0.48 s | 3.21–3.80 s → 0.39–0.41 s |

At load average 16–27 an earlier round on main timed out the ClaudeProbe start at 6.6 s.
Parallel reads alone took the agents-can-communicate turn's store read from 0.39–0.45 s
to 0.14–0.18 s.

## Tests

- `tests/process/hook-read-cost.test.mjs` runs a real `beforeTurn` hook on a store with
  30 messages and 14 sessions under `tests/helpers/store-io-probe.mjs`. Each message and
  receipt is read once, the hook asks for no status, and a heartbeat reads one session
  record. With main's four source files it failed. With only the shared read removed it
  counted 90 message reads, and with only main's heartbeat 30 session reads of 14.
- `tests/process/state-listing-order.test.mjs`: 40 sessions come back in listing order;
  with the result shuffled it failed.

## Limits

This candidate does not index messages by recipient: a turn still reads every message
and receipt once, so its cost still grows with the workspace's backlog, now once rather
than three times.
