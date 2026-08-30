# Session liveness: telling a dead session from an idle one

Status: approved, not implemented
Date: 2026-08-28

## The problem

A session record is created at `sessionStart` and closed at `sessionEnd`. When a
client never fires `sessionEnd` — because it has no such event, or because the
process was killed — the record stays `state: "open"` forever. Presence decays to
`stale` and stops there, because `classifySessionPresence` has no way to ask
whether the process still exists.

The roster then accumulates sessions that will never speak again. Observed in a
real store:

| Workspace | Open session records | Oldest silent record |
|---|---|---|
| `papercut-warzone-2` | 8, of which 6 never closed | 40 h |
| `CodexBar/ClaudeProbe` | 227 | — |

`acc doctor` reports this as `6 live (5 not answering)`, which reads as a fault
and is not one: it is the same fact the roster shows, phrased as a health
problem.

## Why this is not the heartbeat helper we rejected

`DESIGN_DECISIONS.md` settles: *"No heartbeat helper in v1 — an idle session is
honestly reported `stale`. A sidecar process to fake liveness is worse than the
truth."* That decision stands and this design does not touch it. Nothing here
manufactures liveness; it reads liveness that the operating system already
knows. The rejected thing was a process that beats on a session's behalf. This
is a question asked about a process that is already there.

## What is not broken

Two findings bound the blast radius of a wrong answer, and both were verified in
the code rather than assumed.

Presence never releases anything. `claims.mjs:51`: *"Staleness is reported so the
requester can decide what to do; it never releases the claim on its own."*
Misjudging a session as dead cannot hand its files to someone else.

`offline` already means "drop off the roster". `status.mjs:77` filters
`presence !== "offline"`, and `acc status --all` still lists everything. So the
fix needs no new surface: it needs the classifier to be able to reach `offline`
for a session whose process is gone.

The single place where "dead" has authority is `assertReplaceable` in
`sessions.mjs:66`, which permits a replacement generation only when a probe
reports the owner gone. That is the one caller whose behaviour changes from
"never" to "sometimes", and it is the intended change.

## Decisions

| Decision | Reason |
|---|---|
| Both a process check and an age floor | A pid answers "definitely gone" at once; an age floor answers the cases a pid cannot. This mirrors `writer-mutex.mjs`, which reclaims a lock that is dead *and* old. |
| Presence only; never rewrite the record | The record stays `open` and honest. In a system with no session in charge, a bystander editing another session's record is authority it does not have. |
| All open sessions, not only `lifecycle: "manual"` | A `managed` session killed with its terminal leaves the same ghost. Verified: `session_jei0qoUvSIEsN336k3KO-Q` is `claude_code`, `managed`, `open`, with `startedAt == heartbeatAt` and no further beat. |
| No backward compatibility | Confirmed by the maintainer: pre-release, single local tester, store may be deleted. |

## Design

### Resolving the client's pid

The hook is not a child of the client. Measured on the target machine, a process
spawned by Claude Code has parent `/bin/zsh` and grandparent `claude`, so
`process.ppid` yields a transient shell that dies with the hook.

Each adapter already declares the binary it belongs to — `claude`, `kimi`,
`codex`, `gemini` — in `adapter.client.command`, which `detect.mjs:54` uses for
version probing. Reuse it: walk the ancestry from the hook upward and take the
first ancestor whose executable basename equals this adapter's command.
`basename` matters because `ps` reports some entries bare (`claude`) and some
with a path (`/bin/zsh`).

Not found within a bounded number of hops, or no process table available (any
platform without `ps`), records `null`. `null` is a first-class answer meaning
"nobody knows", not a failure.

The ancestry is read once per session at `sessionStart`, from a single
`ps -o pid=,ppid=,comm= -A`, never per turn. New module
`packages/hook-runner/src/client-pid.mjs`, with the process-table reader injected
so tests drive a synthetic table and spawn nothing.

### The classification rule

```
offline   state === "closed"
offline   pid known and not alive          // early, exact
offline   pid unknown and age > UNKNOWN_EXPIRY
offline   age > HARD_EXPIRY                 // pid reuse backstop
online    age <= heartbeatCadenceMs * STALE_CADENCE_MULTIPLE
stale     otherwise
```

The two thresholds catch different failures and neither subsumes the other.

`UNKNOWN_EXPIRY` (30 min) is the "cannot tell" branch: records written before
this change, platforms with no process table, ancestry that did not resolve.

`HARD_EXPIRY` (24 h) exists because pids are recycled — the hazard
`writer-mutex.mjs:72` documents. A dead session whose number was reissued to
something unrelated would otherwise read as alive forever.

`UNKNOWN_EXPIRY` must not apply when the pid is known and alive. A live but idle
session is exactly what a kimi session looks like between turns — its adapter
beats only when the user takes one — so an hour of silence is normal and must
not be read as death.

### Wiring the probe

`classifySessionPresence(session, now, probe = () => true)` already takes the
parameter; none of its seven callers pass it. The default is the danger: a caller
that forgets it disables the check and everything still looks correct.

Make the parameter required, and supply the real implementation once, as a port:
`createCoordinationService({ store, clock, ids, pidIsAlive })`. `service.mjs:19`
threads `ports` into every sub-service, so all seven call sites — in `sync`,
`status`, `claims`, `tasks`, `workstreams` — receive it from one change.
`withWriterMutex` already takes `pidIsAlive` the same way, and `ports.mjs:29`
gives the reason: a port that *"silently falls back to ambient time or randomness
produces tests that pass for the wrong reason and races that only appear on
someone else's machine."*

A missed call site must be a crash, not a silent no-op. This repository has twice
shipped a gate whose green came from somewhere other than the thing it claimed to
check; a defaulted probe would be the third.

`process.kill(pid, 0)` is the check, as in `defaultPidIsAlive`
(`writer-mutex.mjs:16`): `ESRCH` means gone, any other error means present but
not ours to signal.

### Schema

`pid` becomes a declared nullable field on `RECORDS.session`, and
`SCHEMA_VERSION` goes to 2.

The validator is strict in both directions: an undeclared key is rejected
(`schema.mjs:161`) and a declared key that is absent is rejected
(`schema.mjs:166`). `recovery.mjs:54` validates every stored record and files
failures under `corrupt`, which `acc doctor` reports.

The version bump is therefore not ceremony. Without it, every pre-existing record
fails with `session requires pid`, which reads as data corruption. With it, the
same record fails with `unknown schemaVersion: 1`, which is what actually
happened.

**Consequence to state plainly: the existing store must be deleted.** Otherwise
`acc doctor` reports every session record in every workspace as corrupt.

## Failure modes

| Situation | Result | Acceptable because |
|---|---|---|
| Pid resolves to the wrong ancestor | Session judged by an unrelated process's life | Ancestry is matched against the adapter's own binary name, not guessed. A mismatch yields `null`, not a wrong pid. |
| Pid recycled onto a live process | Ghost reads alive | `HARD_EXPIRY` retires it. |
| Live session, unresolvable pid, idle past `UNKNOWN_EXPIRY` | Drops off the roster early | Self-correcting: it returns on its next turn, since the hook beats every turn. Presence releases nothing. |
| Store copied to another machine | Foreign pids checked locally | The store is per-machine by design. Age floors still bound the error. |
| No `ps` (Windows) | Every session takes the unknown branch | Degrades to the age-only behaviour, which is strictly better than today. |

## Testing

- Table test over all six branches of the rule: closed; pid dead; pid alive and
  fresh; pid alive and past `HARD_EXPIRY`; pid unknown and fresh; pid unknown and
  past `UNKNOWN_EXPIRY`.
- Ancestry resolver against a synthetic process table: direct child, child behind
  a shell, no matching ancestor, empty table, cycle guard.
- `sessionStart` records a pid in the session record.
- Regression: a roster drops a session whose pid is dead, and `--all` still lists
  it.
- A caller omitting the probe fails loudly.

None of this needs a live client, which matters because kimi cannot currently be
driven by a live model in test.

## Out of scope

Closing ghost records durably, reaping them on a schedule, and any change to what
`acc doctor` calls a fault. This change makes the roster tell the truth; deciding
that a truthful roster should also be tidied is a separate question.
