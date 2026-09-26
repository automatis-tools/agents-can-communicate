# Unreleased fixes from the first real 0.8.0 update

All four defects were found on the maintainer's machine right after the published 0.8.0
updated it. They came from reading the managed runtime's records, `acc doctor`, `acc status`
and the process table. Only the third is new in 0.8.0.

## 1. A pin that names no client

A pin records the generation a session started with, so that session's hooks keep running it
after an activation. `reclaimGenerations` keeps every generation a pin names, and `reapPins`
removes a pin only when its `clientPid` is confirmed dead. A pin written with `clientPid: null`
therefore stayed until `SessionEnd` cleared it, and nothing else ever could.

Two paths in the `SessionStart` handler wrote such a pin. A repeated start rewrote the pin
before the client's pid was looked up, so a hook that died between the two left it pid-less.
Every later write passed the looked-up pid, which is `undefined` when no client process is found
among the hook's ancestors. Fix 4 below removes the most common reason for that.

After the update, the machine's `runtime/pins` held two such records:

| Pin | Generation it held | Written | Session |
|---|---|---|---|
| `eb0b14cf…` | `0.5.10` | 2026-09-21 | a Claude Code session that ended without `SessionEnd` |
| `4afbdfca…` | `0.6.0` | 2026-09-22 | an Antigravity hook run with no client process behind it |

Every other pin and lease named a live process. So these two records alone kept both
generations on disk, and would have done so indefinitely.

The design already says a pin is safe to retire: it only names the generation a session
prefers, and a hook falls back to the active generation when a pin is missing, when its
generation is gone, or when its entrypoint fails to import. The fix follows that.

- `writePin` writes nothing when the client pid is not a positive integer. Such a session is
  unpinned, and its hooks run the active generation.
- A repeated start passes the pid its binding already recorded. If this start's lookup fails,
  the refreshed pin is still reapable.
- `reapPins` removes a well-formed pin that names no client. A record it cannot read or does
  not recognise stays an unknown holder, as before, and still postpones reclamation.

## 2. A Codex control socket nothing listens on

`probeNativeDelivery` checks the control socket with `lstat` and then connects. On the machine,
`~/.codex/app-server-control/app-server-control.sock` was a socket file from 2026-09-09, and no
Codex process was running. `lstat` accepted it, and the connection was refused in 2 ms. The
probe mapped every error other than a timeout to `feature_probe_failed`, so doctor reported
"the native protocol probe did not succeed".

The fact is that the service is gone. `native_endpoint_unavailable` is the code detection keys
its advice on: `nativeSetup` names `codex app-server daemon start`, and service preparation
names the same step. The probe now maps a refused or vanished transport (`safeReason` answers
`transport_unavailable`: `ECONNREFUSED`, `ENOENT`, `EPIPE`) to `native_endpoint_unavailable`.
A timeout keeps `probe_timeout`, and anything else keeps `feature_probe_failed`.

The test reproduces the machine's state with a real stale socket. A listener in a child process
is killed with `SIGKILL`, because a graceful `close()` unlinks the file. Measured with Node 26:
after `close()` the file is gone; after `SIGKILL` it stays a socket, and the real client's
connection fails with `ECONNREFUSED`.

Service inspection needed the same correction. The stopped service had also left its PID
record, `{"pid":30290,…}` from 2026-09-09, and no process 30290 existed. Either file sent
inspection down its verify path, and `codex app-server daemon version` exited 1 on the refused
socket, so doctor on the machine printed
`Codex service preparation could not verify daemon_version_unavailable; inspect the vendor
service and retry acc install`, a raw code with no action in it.

What restarts it was measured with Codex 0.155.1 in a separate `CODEX_HOME` holding the same
leftovers, linked to the installed standalone package. `codex app-server daemon start` returned
`started`, replaced the socket, and wrote a new PID record: once with only a leftover socket,
and once with the socket and a PID record naming a dead process. The test daemons and their
`pid-update-loop` helpers were stopped afterwards, and the temporary homes removed; the
machine's own `~/.codex` was never touched.

Inspection now reports `service_stopped`, state `blocked`, when the recorded process is
confirmed dead or absent (`approvedProcessIsDead`, the rule maintenance already uses) and the
socket is absent or is a socket, owned and not a symlink, that refuses connections. The advice
reads "The Codex service stopped and left its files behind; start it with codex app-server
daemon start, which replaces them, then open a new Codex session". ACC's own start keeps the
existing definite-absence rule: it runs `daemon start` only when neither file exists, so
setup still never starts over leftover files itself. A PID record naming a live process, an
unreadable or unsafe record, a symlink, or a socket that fails with anything but
`ECONNREFUSED` is not a stopped service.

## 3. A closed participant listed for an answer it already saw

After a Claude Code session A exited, `acc status` printed
`waiting for a closed session: claude_code-cudrff (1)`. The one message was B's answer to A:
`kind: answer`, `obligation: none`. Its receipt was `offered`, by the `next-turn` transport,
with `repeatedAt: null`. The next-turn hook had already put the body in A's context, and a
next-turn offer is never repeated. So nothing would reach A for it again, and nothing was owed,
but status counted every queued and offered receipt and kept A listed for good.

A message now waits for a closed participant when its next turn would still show it: queued,
or offered by a live transport and not yet shown again. That is `dueForRepeat`'s rule without
its elapsed time, extracted in `receipts.mjs` as `awaitsNextTurn` so the two cannot drift.
An offer an older ACC recorded without facts is unknown and counts as waiting.

- The roster keeps an offline participant while that number is above zero, and the entry
  carries it as `waiting` beside `endReason`.
- The text line prints `waiting`, and names only offline entries with something waiting, which
  also keeps `acc status --all` from naming every closed session.
- `unretrieved: {queued, offered}` and `counts.unretrieved` keep their meaning. The computation
  reads the snapshot only; the store format and `STORE_VERSION` 6 are unchanged.

## 4. A client that runs as a node script

A hook learns its client's pid by walking its ancestors for the one whose executable basename is
the adapter's `client.command`. A headless Gemini CLI 0.60.0 session opened with `pid: null`,
while Codex and Claude Code sessions got theirs. Gemini CLI is a node script: its realpath is
`@google/gemini-cli/bundle/gemini.js`, reached through the `bin/gemini` symlink. So every
ancestor's comm is `node`. Measured during a run:

```
46006     1 node             node .../bin/gemini -p ... --yolo
46032 46006 .../bin/node     .../bin/node --max-old-space-size=65536 .../bin/gemini -p ...
```

The first process relaunches itself with a bigger heap, and hooks run under the second. Without
a pid, the session is judged by heartbeat age alone and, after fix 1, is never pinned.

The process table now also reads `ps -A -o pid=,args=`, in parallel with the existing
`ps -o pid=,ppid=,comm= -A` and within the same timeout, parsed as a pid plus the whole rest of
the line. The read has a 16 MiB buffer: command lines measured 231 KB for 1,137 processes on a
desktop Mac, and each read took about 30 ms. For an ancestor whose comm is `node`, the walk also
matches the script it runs. The interpreter is skipped by its comm, so a path with spaces is
skipped whole. Options are skipped too. The first remaining word matches by basename, with a
`.js`, `.mjs` or `.cjs` extension ignored. The walk still returns the innermost match, 46032
above.

The pull request's AI review found that an option taking a separate value hid the script:
`node --require ./preload.cjs /path/gemini.js` selected `./preload.cjs` and found no client.
Which options take a value depends on the client's own node, so no list is kept. A word right
after an option written without `=` is tried as a candidate and the search continues; it ends
at the first word no such option precedes. `node --require ./preload.cjs /srv/server.js gemini`
still names only `server`, and an option written as `--flag=value` leaves the next word the
script. A boolean option before a script whose first argument is the client's name would also
match; the walk stops at the innermost match, which is the client's own process whenever it
is an ancestor, so that wider match cannot displace it. A failed or slow command-line read leaves every entry as before. Claude Code, Codex, Grok
and Antigravity are native binaries and still match by their comm alone.

A stand-in shaped like Gemini ran through the real `ps` on this machine. It was a node script
reached through a `bin/gemini` symlink, which relaunched itself with `--max-old-space-size`, and
its hook ran `node hook.mjs`. The hook resolved the relaunched process's pid.

## Checked against the machine's own state

The branch's `acc doctor` and `acc status` ran directly from the worktree, without the managed
runtime, against a copy of the machine's data home and its real client homes, beside the
published 0.8.0 run the same way.

| Check | Published 0.8.0 | This branch |
|---|---|---|
| Codex live delivery reason | `the native protocol probe did not succeed` | `the client's local delivery service is unavailable` |
| Codex service line | none; with fix 2 alone, `could not verify daemon_version_unavailable` | `The Codex service stopped and left its files behind; start it with codex app-server daemon start, …` |
| Scratch project status | `waiting for a closed session: claude_code-cudrff (1), claude_code-0ah3im (1), loc-sender (14)` | `waiting for a closed session: claude_code-0ah3im (1), loc-sender (14)` |
| Another project's status | `claude_code-m5YAzG (2)` | `claude_code-m5YAzG (2)` |

`claude_code-cudrff` held only B's answer, already shown by its next turn. The other entries
are queued messages that the next turn would show: C05's question to an exited session, and
replies to a CLI sender that never read its inbox.

## Tests

Each test was seen failing for the stated reason before its fix.

- `packages/cli/test/managed-runtime-pins.test.mjs`: a pin write without a pid writes nothing;
  a legacy pin with `clientPid: null` is reaped.
- `packages/cli/test/managed-runtime-retention.test.mjs`: a generation named only by a
  pid-less pin is reclaimed.
- `packages/hook-runner/test/session-pin-client.test.mjs`: a start that finds no client writes
  no pin; a repeated start whose lookup fails re-pins the current generation with the pid the
  binding knew; a Gemini-shaped start records the node script client's pid in its pin.
- `packages/adapter-codex/test/native-delivery.test.mjs`: a stale socket probes as
  `native_endpoint_unavailable`, and detection turns that into the daemon start advice; a
  timeout and any other failure keep their own codes.
- `packages/adapter-codex/test/service-setup.test.mjs`: a leftover socket, a leftover socket
  with a dead PID record, and a dead PID record alone each get `service_stopped` with the start
  advice and no ACC start; a PID record naming a live process, an unsafe PID record, an
  accepting socket, a socket refusing permission, a symlink and a regular file are not a
  stopped service.
- `packages/core/test/receipt-visibility.test.mjs`: a next-turn offer and a repeated live offer
  do not keep a closed participant listed; a queued message, a live offer not yet repeated and
  an offer without facts do, with `waiting` set; `unretrieved` is unchanged.
- `packages/cli/test/status-line.test.mjs`: the text line counts `waiting` and skips an offline
  entry with nothing waiting; `(cleared, n)` still reads as before.
- `packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`: the measured Gemini
  tree resolves to the relaunched process; `--require`, `-r` and `--import` with separate values
  do not hide the script, while an attached `--flag=value` and a script's own later arguments
  do not widen the match; an extension, an interpreter path with spaces, a
  later positional argument, another interpreter and a table without command lines each behave
  as stated; command lines parse beside the tree, a failed read leaves the tree as before, and
  both reads share the caller's timeout.

Each changed production line was mutated, and a test failed every time. That covered 33
mutations across `pins.mjs`, `runner.mjs`, `native-delivery.mjs`, `receipts.mjs`, `status.mjs`,
`main.mjs`, `client-pid.mjs`, `process-table.mjs`, `service-setup.mjs` and `native-endpoint.mjs`.
The ones that first survived got their own tests: Codex's timeout branch, the socket type
guard (a symlink), an unsafe PID record, a dead PID record without a socket, and a connect
failing for a reason other than refusal, and an option written with its value attached.

`npm test` on the evidence commit `7d144e7`: 2,619 tests, 2,618 passing, 0 failing, 1 skipped.
The skipped test plans an uninstall from the install record and skips on a machine where
Gemini CLI is installed, as it does on `main`.

## Exact local artifact

- Source: clean commit `58fe458a4bdc58f1a2b0c78f2a1cd8ed908168cc` on `fix/pidless-session-pins`,
  from `main` at `00c5416`.
- Archive: `agents-can-communicate-0.8.0.tgz`, packed from that commit.
- Size: 471,257 bytes; 311 packed entries.
- SHA-256: `26be0d83d64c4ea10a549c3e859a7d8080b9590148a508dad6c999ab2c5a55ce`.
- Package version remains `0.8.0`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: 311 entries with none forbidden, six
certification manifests, every packed Markdown link resolving, the root and 15 bundled
workspaces at `0.8.0`, a clean installation, doctor, a workspace with no Git, and client
install/uninstall.
