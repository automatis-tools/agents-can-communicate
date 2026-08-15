# Task 8 report — strict CLI and machine-readable output

## Scope

Implemented `tools/agents/lib/args.mjs` and the executable `tools/agents/comms.mjs` without changing the established protocol-library interfaces. The executable discovers the bus once, builds one shared runtime context, dispatches every current v1 command, maps `CommsError` to its stable exit code, and prints unexpected failures with a stack and exit 1.

`--json` writes exactly one JSON value on stdout. Human paths emit human text only. `watch` writes JSONL events on stdout and routes the terminal bell to stderr, so it cannot corrupt the stream. The watcher receives real claim-extension and close/release callbacks; signal handling awaits its asynchronous stop.

## TDD evidence

RED: `node --test tests/tools/agent_comms/integration.test.mjs` exited 1 before production code existed, with `ENOENT` for `tools/agents/comms.mjs`.

GREEN: focused parser/subprocess tests passed 6/6. The full protocol suite passed 169/169.

## Acceptance coverage

- All implemented commands exercised via subprocess: `init`, `register`, `close`, `send` (inline/file/stdin), `broadcast`, `inbox`, `ack`, `reply`, `watch`, `wait`, `claim`, `release`, `handoff`, `status`, and `doctor`.
- Subprocess tests assert stable exits 0, 2, 3, 4, 5, and 6; `--json` parsing; executable shebang and executable mode; and JSONL-only watch stdout.
- Parser tests cover repeated ownership, message body-source exclusivity, repeated handoff fields, force-stale owner requirements, missing values, unknown options, and unknown commands.
- Runtime/test module raw line counts: `comms.mjs` 275, `args.mjs` 94, `helpers.mjs` 284, `args.test.mjs` 40, `integration.test.mjs` 117.

## Verification

```text
node --check tools/agents/comms.mjs
node --check tools/agents/lib/args.mjs
node --test tests/tools/agent_comms/args.test.mjs tests/tools/agent_comms/integration.test.mjs
# 6 passed, 0 failed
node --test tests/tools/agent_comms/*.test.mjs
# 169 passed, 0 failed
git diff --check
# clean
```

## Self-review

Checked command-to-library mappings, output stream separation, force-stale authorization delegation, one-time path discovery, and watcher callback wiring. A constrained filesystem watcher is safely degraded to the existing polling scan when the operating system rejects additional watch handles; it still preserves JSONL output and delivery semantics.

No deviations from Task 8. Task 9 prompt/documentation files were not touched.

## Round 1 — accepted review findings

RED: the new Round 1 test file first failed because `runWithSignals` did not exist. This established the missing lifecycle seam before production changes.

GREEN: `node --test tests/tools/agent_comms/cli-round1.test.mjs` passed 5/5, then the full protocol suite passed 174/174.

- `send`, `broadcast`, and `reply` now read stdin only when neither `--body` nor `--body-file` is selected. Six real subprocess cases leave stdin open and still exit 0.
- Signal coordination is isolated in `signal-stop.mjs`. It latches SIGINT/SIGTERM received before watcher publication and awaits `stop()` before completion. A deterministic injected lifecycle test verifies offline presence after the latched SIGTERM; subprocess tests retain SIGINT and add SIGTERM acceptance.
- Black-box tests assert finite successful human output contains human text only, and exercise both denied non-orchestrator and successful orchestrator `release --force-stale --owner` paths.
- Round 1 line counts remain below 300: `comms.mjs` 278, `signal-stop.mjs` 24, and `cli-round1.test.mjs` 120.
