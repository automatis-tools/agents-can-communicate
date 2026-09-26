# Unreleased four fixes from the first real 0.8.0 update

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

Doctor's final line on such a machine also depends on Codex service inspection. The socket file
exists, so that inspection takes its verify path, which asks `codex app-server daemon version`.
Its result on the machine was not measured here.

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
above. A failed or slow command-line read leaves every entry as before. Claude Code, Codex, Grok
and Antigravity are native binaries and still match by their comm alone.

A stand-in shaped like Gemini ran through the real `ps` on this machine. It was a node script
reached through a `bin/gemini` symlink, which relaunched itself with `--max-old-space-size`, and
its hook ran `node hook.mjs`. The hook resolved the relaunched process's pid.

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
- `packages/core/test/receipt-visibility.test.mjs`: a next-turn offer and a repeated live offer
  do not keep a closed participant listed; a queued message, a live offer not yet repeated and
  an offer without facts do, with `waiting` set; `unretrieved` is unchanged.
- `packages/cli/test/status-line.test.mjs`: the text line counts `waiting` and skips an offline
  entry with nothing waiting; `(cleared, n)` still reads as before.
- `packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`: the measured Gemini
  tree resolves to the relaunched process; an extension, an interpreter path with spaces, a
  later positional argument, another interpreter and a table without command lines each behave
  as stated; command lines parse beside the tree, a failed read leaves the tree as before, and
  both reads share the caller's timeout.

Each changed production line was mutated, and a test failed every time. That covered 21
mutations across `pins.mjs`, `runner.mjs`, `native-delivery.mjs`, `receipts.mjs`, `status.mjs`,
`main.mjs`, `client-pid.mjs` and `process-table.mjs`. The one that first survived, Codex's
timeout branch, got its own test.

## Exact local artifact

- Source: clean commit `3cacc5cdc8c7d2567b29952032a0ebf34fada8d7` on `fix/pidless-session-pins`,
  from `main` at `00c5416`.
- Archive: `agents-can-communicate-0.8.0.tgz`, packed from that commit.
- Size: 470,521 bytes; 311 packed entries.
- SHA-256: `b4b4bf3fdcfd5342070135d05c5007b4ea9baa2e3e5764d21627268d0abee85d`.
- Package version remains `0.8.0`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: 311 entries with none forbidden, six
certification manifests, every packed Markdown link resolving, the root and 15 bundled
workspaces at `0.8.0`, a clean installation, doctor, a workspace with no Git, and client
install/uninstall.
