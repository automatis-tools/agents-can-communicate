# Unreleased — find a client the session start missed

This development candidate fixes sessions that kept `client_process_unknown` for
their whole life after a slow start. It is not a published release. The package still
declares version 0.11.0; these candidate bytes differ from the published 0.11.0
artifact, whose original record remains unchanged.

## Source and artifact

| Fact | Value |
|---|---|
| Source commit | `94b9bbae9661e6009f188bb22ef9619b98eb32ea` |
| Source state at pack time | clean feature worktree |
| Archive | `agents-can-communicate-0.11.0.tgz` |
| Archive size | 608,582 bytes |
| Packed files | 374 |
| SHA-256 | `57695a53b3f84ecba5b6fcf15010cddce2155b5603f915eac8b50e6546f88634` |
| Local environment | macOS, Node 26.5.1 |

`node scripts/verify-package.mjs` passed on the clean worktree and reported the same
digest as a separate `npm pack`.

## Cause

A Claude Code 2.1.296 session started on 2026-10-12 at 05:18Z showed `ACC ! · turn`
with `client_process_unknown`. The machine's load average was 56–84 on 18 cores.
The store and the session's transcript were read without changes:

- The SessionStart hook ran 37 s and completed. The session opened at 05:18:07Z,
  35 s before the first prompt, so a later turn did not open it.
- The binding has the client's version and platform but no `clientPid`. The session
  record has `"pid": null`. There is no runtime pin, which needs a pid.
- The start read the whole process table: every pid, parent and command line, about
  1,900 processes. The read has a 1 s limit. A read that passes the limit is an empty
  table, so no client is found.
- No later hook looked again. `beforeTurn` re-ran the start path only for a missing
  binding, a closed session, or a known client pid that had exited. Every turn then
  bound native delivery without a pid and recorded `degraded / client_process_unknown`.

Every other recent Claude Code session on the machine had `clientProcess: identified`.

## Measurements

Times for the `ps` calls a hook can make on this Mac:

| Read | Load average | Time |
|---|---|---|
| whole table, parents and executables | 69 | median 832 ms, max 898 ms |
| whole table, command lines | 69 | median 954 ms, max 1426 ms |
| one process | 69 | median 7 ms |
| one process, 12 at once | 69 | median 196 ms, max 554 ms |
| one process, each field alone | 90 | median 29–80 ms |

The hook's chain on this machine is `node` (the hook), `/bin/zsh`, `claude`, the
terminal's shell, then IntelliJ IDEA. At load average 16, from a process under this
Claude Code session, the new walk read 3 processes in 8–12 ms and named Claude's pid.
Main's whole-table read took 77–83 ms for about 1,880 processes and named the same pid.

## Change

- On POSIX, `readProcessTable` reads the chain from `from` upward, one `ps -p` call
  for the parent and executable and one for the command line, both at once. The
  limit bounds the whole walk. The optional `until` ends the walk at the process the
  caller is looking for. Windows already read only the chain and is unchanged.
- The hook runner reads the table through one helper, which stops at the adapter's
  declared client.
- A `beforeTurn` whose binding has no client pid reads the chain again, for adapters
  that declare a client command. A client found then takes the existing restart path,
  with the same ACC session and generation. It binds again with the pid, using the
  table that turn already read. While the client stays unknown, each turn makes one
  bounded read. Only the open generation the binding names is looked up: the first
  full suite caught a turn on a stale binding that found the fixture client and
  entered the start path. The start path refuses such a binding too.
- `client_process_unknown` advice in the indicator, doctor and troubleshooting now
  says the next prompt looks for the client again.

## Real-process evidence

At the recorded commit, at load average 89, `bin/acc-hook.mjs` ran as a real hook process,
as a child of a shell whose parent was
the running Claude Code 2.1.296 process (pid 89125). It used an isolated
`ACC_DATA_HOME`, a fixture session id, and no Claude messaging socket. SessionStart ran
with a `ps` on `PATH` that slept 2 s before it ran the real one. The two prompts that
followed ran with the real `ps`.

| Build | After start | After prompt 1 | After prompt 2 |
|---|---|---|---|
| main | no pid, client unknown | no pid, client unknown | no pid, client unknown |
| this change | no pid, client unknown | pid 89125, client identified | pid 89125, client identified |

The isolated data home had no delivery consent, so the attempts recorded `off`. Without
a pid, a run with delivery consent records `degraded / client_process_unknown`.

## Tests

- Hook runner: a session whose start found no client binds it on the next turn with the
  same session and generation. A turn that still finds none keeps the session and reads
  once per turn. An adapter without a client command is never looked up. Before the
  change, the first two failed.
- Process table: the POSIX chain, the early stop, a limit for the whole walk, an
  unreadable process, and the large buffer for one command line. The earlier
  whole-table parsing tests now answer per pid.

## Limits

This candidate changes no record schema, store contract or delivery protocol. The
real-process run proves the lookup and the binding. It did not run a model turn or
exercise live delivery through a Claude messaging socket.
