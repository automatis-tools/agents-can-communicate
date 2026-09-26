# Unreleased old runtimes are freed and a dead Codex service is named

Both defects were found on the maintainer's machine right after the published 0.8.0 updated it,
by reading the managed runtime's own records and `acc doctor`. Neither is new in 0.8.0.

## A pin that names no client

A pin records the generation a session started with, so that session's hooks keep running it
after an activation. `reclaimGenerations` keeps every generation a pin names, and `reapPins`
removes a pin only when its `clientPid` is confirmed dead. A pin written with `clientPid: null`
therefore stayed until `SessionEnd` cleared it, and nothing else ever could.

Two paths in the `SessionStart` handler wrote such a pin. A repeated start rewrote the pin
before the client's pid was looked up, so a hook that died between the two left it pid-less.
Every later write passed the looked-up pid, which is `undefined` when no client process is found
among the hook's ancestors.

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

## A Codex control socket nothing listens on

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

## Tests

Each test was seen failing for the stated reason before its fix.

- `packages/cli/test/managed-runtime-pins.test.mjs`: a pin write without a pid writes nothing;
  a legacy pin with `clientPid: null` is reaped.
- `packages/cli/test/managed-runtime-retention.test.mjs`: a generation named only by a
  pid-less pin is reclaimed.
- `packages/hook-runner/test/session-pin-client.test.mjs`: a start that finds no client writes
  no pin; a repeated start whose lookup fails re-pins the current generation with the pid the
  binding knew.
- `packages/adapter-codex/test/native-delivery.test.mjs`: a stale socket probes as
  `native_endpoint_unavailable`, and detection turns that into the daemon start advice; a
  timeout and any other failure keep their own codes.

Each changed production line was mutated, and a test failed every time: the `writePin` guard,
the pid-less reap, the repeated start's pid, the unknown-shape guard in `reapPins`, the
transport mapping, the timeout branch, and the fallback code.

## Exact local artifact

- Source: clean commit `da734573785a8b927bee5f396b549c6cb755e03a` on `fix/pidless-session-pins`,
  from `main` at `00c5416`.
- Archive: `agents-can-communicate-0.8.0.tgz`, packed from that commit.
- Size: 469,236 bytes; 311 packed entries.
- SHA-256: `c4e8ff1eae0e6cf05f3a02aa73a4d63b2b0748f2645fb0d6afa9a0241608ecad`.
- Package version remains `0.8.0`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: 311 entries with none forbidden, six
certification manifests, every packed Markdown link resolving, the root and 15 bundled
workspaces at `0.8.0`, a clean installation, doctor, a workspace with no Git, and client
install/uninstall.
