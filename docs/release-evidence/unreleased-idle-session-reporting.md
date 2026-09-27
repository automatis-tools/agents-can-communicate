# Unreleased idle and working sessions reported as broken

Implements [the 2026-09-27 design](../design/2026-09-27-idle-session-reporting.md) for #209,
#210 and #215. The defects were found on ACC 0.8.1 with Claude Code 2.1.283, Codex 0.157.1,
Antigravity CLI 1.2.12 and Grok 1.0.41 sessions open in one workspace, by sending each idle
session a question and comparing the answers with what doctor and status said.

## What was measured before the change

- Doctor called the idle Claude Code and Codex sessions `degraded`, their adapters `channel
  unreachable`, and advised starting a new client session. A read-only receiver
  re-verification returned supported for all three, and a question to each was delivered
  live: Claude Code through `claude-inbox`, answered in 12 seconds; Codex through
  `codex-app-server`, answered in about 9.
- Status counted four sessions as not answering, all with live client processes.
- This session's heartbeat was written at 05:24:00 UTC and it read `stale` at 05:29:50,
  in the middle of a turn of shell commands.

## What changed

- `cli/native-session-diagnostics.mjs` re-verifies every bound session, not only one with a
  live lease. The session runtime is `active`, `idle` (verified, lease lapsed) or `degraded`
  (refused, with its reason). An adapter with no re-verification keeps the lease answer. A
  verified session lifts an adapter the binding pass had marked `degraded`.
- `core/status.mjs` adds `processTracked` and `liveDelivery` to each participant row. A lapsed
  lease still counts as a live binding.
- `cli/main.mjs` adds `presenceBreakdown`; `describePresence` takes it and names each group.
  Without one it keeps the earlier wording. Status and doctor both pass it.
- `hook-runner/runner.mjs` heartbeats in the no-target branch of `beforeTool` from the
  session's own record, under the existing at-most-twice-a-cadence rule.
- `docs/CLI.md` explains the stale groups and the two fields.

## Tests

Each new or changed test was seen failing for its stated reason before the change that made
it pass.

- `packages/cli/test/native-session-deliverability.test.mjs`: the test that asserted a lapsed
  lease is never re-verified now asserts the opposite. A verified receiver reads idle and
  lifts the adapter; a refusal is degraded with its reason; an adapter with no
  re-verification stays degraded.
- `tests/process/heartbeat.test.mjs`: a shell command after four quiet minutes makes the
  session online; two shell commands moments apart write nothing.
- `packages/core/test/status.test.mjs`: three stale sessions report `liveDelivery` and
  `processTracked` for a bound, a hooked and an untracked session.
- `packages/cli/test/install-command.test.mjs`: the breakdown and the wording, including
  `not answering` and `present, none answering` for untracked sessions.

Mutations, each caught by a test: removing the adapter lift, heartbeating on every shell
command, and ignoring `liveDelivery` in the breakdown.

`npm test` on the evidence commit `ffeabaa`: 2,646 tests, 2,646 passing, 0 failing, 0 skipped.
Nothing was re-run.

## Measured on this host

Run from this worktree's code against the real workspace at 06:02 UTC, beside the
installed 0.8.1:

| | 0.8.1 | this change |
|---|---|---|
| status | `5 live (4 not answering)` | `5 live (3 idle, wake on send; 1 idle, inbox only)` |
| doctor sessions | `degraded` three times | `idle, lease lapsed; receiver verified; the next send refreshes it` |
| doctor adapters | `channel unreachable`, restart advice | `local transport active`, no restart advice |

## Exact local artifact

- Source: clean commit `5500d9337ddb30cc72e320a698e19534595e7a4f` on
  `fix/idle-session-reporting`.
- Archive: `agents-can-communicate-0.8.1.tgz`, packed from that commit.
- Size: 473,693 bytes; 311 packed entries.
- SHA-256: `8eebdc6acd2d436a76bf9b7a58f6f38b35361092a343e8179925b2aee455f1cf`.
- Package version remains `0.8.1`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
