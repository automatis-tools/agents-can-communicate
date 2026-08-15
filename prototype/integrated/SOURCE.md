# Integrated prototype provenance

Baseline: `9a866cf16f97a0aa1af7ea792acc79bc02278633`
Archived source: `../papercut-agent-comms/`
Hardening evidence: `../../migration/patches/`

This directory is the mutable reconciliation target. It is not the standalone
package layout.

## Baseline verification recorded before copying

Environment: Node `v24.4.0`, `Darwin 25.5.0 arm64`, repository HEAD
`23ed1951478eae2b66d2ca47d36af41914beb494` on branch
`chore/prototype-reconciliation`.

| Command | Observed |
|---|---|
| `npm run test:prototype` | 181 tests, 180 pass, **1 fail**, duration 8501 ms |
| `npm run test:prototype:sigterm` | 1 test, 0 pass, **1 fail**, exit 1 |

Both failures are the same case, `SIGTERM is accepted by the executable watcher
lifecycle` in `tests/tools/agent_comms/cli-round1.test.mjs:108`, asserting
`null !== 0`.

This deviates from the transfer-staging record in `docs/PROGRESS.md`, which
reported the focused run passing and only serial/parallel runs failing. On this
machine the focused run fails as well. The deviation is recorded here rather
than hidden.

### Measured root cause

The failure was diagnosed by measurement, not by inference. A diagnostic run
against the immutable baseline observed, over three repetitions:

- `locks/watcher-models.json` published at ~103 ms after `spawn`;
- `presence/models.json` with `status: "online"` and the child's own pid at
  ~109 ms after `spawn`;
- terminating at the baseline's fixed 80 ms yields `code: null`,
  **`signal: "SIGTERM"`** — death by the default signal disposition, meaning the
  child had not yet installed its handler;
- terminating at 300 ms and at 1000 ms yields `code: 0`, `signal: null`;
- terminating after a condition-based wait yields `code: 0` in every repetition.

`withSignalStop` registers `SIGINT`/`SIGTERM` synchronously before `main` runs,
so handler installation strictly precedes watcher-ownership publication. The
80 ms constant simply sits below this machine's ~103 ms startup cost. This is a
test-harness timing flaw in preserved source behavior, not a production watcher
defect, and it is not transfer corruption: all 49 archived blobs match source
commit `9a866cf` exactly.

### Correction applied to this snapshot

`tests/tools/agent_comms/cli-round1.test.mjs` now waits, on a bounded 10-second
loop, until the watcher-ownership lock exists **and** the presence record
validates as `online` with the child's own pid, then sends `SIGTERM`. Timeout and
premature-exit failures report the last observed child stdout and stderr. The
assertion compares `{ code, signal }` so a future regression names its failure
mode instead of reporting `null !== 0`. No sleep was lengthened.

Gate liveness was demonstrated: removing the `SIGTERM` registration from
`tools/agents/lib/signal-stop.mjs` makes the corrected test fail with
`watcher did not stop gracefully: {"code":null,"signal":"SIGTERM"}`. The
production file was restored immediately and verified byte-identical to the
immutable baseline.

This is the only intentional difference between `../papercut-agent-comms/` and
this snapshot at the Task 1 boundary. Production trees are identical.
