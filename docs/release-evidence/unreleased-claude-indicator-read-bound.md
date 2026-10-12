# Unreleased — Claude indicator read bound

This development candidate fixes the Claude Code indicator diagnostic that repeated in
every open session on a loaded Mac. It is not a published release. The package still
declares version 0.11.0; these candidate bytes differ from the published 0.11.0
artifact, whose original record remains unchanged.

## Source and artifact

| Fact | Value |
|---|---|
| Source commit | `03c12de4688a3044fb190c8c27af703a445165c0` |
| Source state at pack time | clean feature worktree |
| Archive | `agents-can-communicate-0.11.0.tgz` |
| Archive size | 608,110 bytes |
| Packed files | 374 |
| SHA-256 | `20c9240f7bdb5ce180082e2cbf086097d17a609820befae7cc751d2b31552c01` |
| Local environment | macOS, Node 26.5.1 |

`node scripts/verify-package.mjs` passed on the clean worktree and reported the same
digest as a separate `npm pack`.
The fix itself is commit `609e4120`. The recorded commit adds only a test change;
the archive packed from both commits has identical bytes.

## Cause

User screenshots showed "The ACC indicator could not read this session's state" printed
many times in four Claude Code 2.1.296 sessions, and once at the start of a new one.
The machine's load average was 56–84 on 18 cores.

- The installed reader was healthy. Spawned directly from Node, 40 reads at the same
  load took 154–227 ms; every read printed valid JSON.
- A probe module in an isolated Claude Code 2.1.296 TUI repeated the indicator's exact
  `$.process.run` call once per second for two minutes. 108 reads took 176–1300 ms
  (median 526, 90th percentile 880). Claude rejected 3 as "still running after 1200ms",
  including the read at session start.
- `acc-indicator` answers at the latest 1.5 s after its modules load. The module's
  1.2 s bound was shorter than that deadline, so Claude killed reads that would have
  answered.
- The module re-armed its diagnostic after every healthy read. Each lost read between
  healthy reads printed the same diagnostic again.

## Change

- Each read has five seconds, equal to the steady refresh period.
- A rejected read, unparsable output, or a reader-reported `indicator_unavailable` or
  `state_unreadable` keeps the last observed state. Three such reads in a row replace
  it, show `!`, and print one diagnostic.
- A read that Claude stopped waiting for says the indicator did not answer within five
  seconds. A read that could not start keeps the reinstall command.

## Real-client evidence

Four isolated Claude Code 2.1.296 TUIs ran for 100 s each, at the same time, with the
installed ACC plugin disabled. Each loaded one copy of the indicator module through
`--plugin-dir`. A fixture wrapper pointed each read at one registered, healthy session
and added the delay below before loading the real `acc-indicator`.

| Module | Delay | Reads | Diagnostics printed | `!` drawn |
|---|---|---|---|---|
| previous (1.2 s bound) | 1.5 s on every second read | 21 | 8 | 8 times |
| new | 1.5 s on every second read | 21 | 0 | never |
| new | 6 s on every second read | 19 | 0 | never |
| new | 6 s on every read | 17 | 1 ("did not answer within five seconds") | once |

The installed-module tests reproduce the same cases with a scripted host. Before the
change, five of the six new tests failed: one isolated lost read changed the badge and
printed the diagnostic, and the bound was 1200 ms.

## Footer composition tests

The first full suite at this change failed two Kimi footer composition tests, which
already existed on main. Their output was the timeout fallback `ACC ! · acc doctor`:
at load average 75–114 the real 180 ms Kimi budget expired before the reader
answered. Repeated alone, they failed in 4 of 8 runs. They check composition and
sanitising, so they now use the controlled clock their sibling test already used.
Six repeated runs of the file then passed at load average 114. Separate tests still
advance time to cover the deadline and the cleanup of a previous footer's processes.

## Limits

This candidate changes no reader output, record schema, store contract or delivery
behaviour. The captures prove the module's timing and messages in the real client.
They did not exercise registration or delivery, and no model turn ran.
