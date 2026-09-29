# Unreleased: an empty Codex chat is addressable

## What was measured

Issue #167: a new Codex chat loads its thread in the shared daemon at startup, but
`SessionStart` waits for the first turn, so no peer could address the chat until someone typed.
Measured on 2026-09-28 and 2026-09-29 (macOS arm64, ACC 0.8.3, Codex CLI 0.158.0):

- A `thread/queue/add` into the untouched thread starts a turn 0.02 s later, and the ACC hooks
  open a participant in that turn.
- The daemon unloads an idle thread with no subscribers about a minute after its TUI exits and
  runs `SessionEnd`, also for a thread that never had a turn (#212).
- `hooks/list` with `cwds` returns each hook's `enabled` and `trustStatus` per directory.
- Thread metadata carries `parentThreadId`, `ephemeral`, `status` and `cwd` without any turn.

## What changed

- `packages/adapter-codex/src/native-discovery.mjs`, `app-server-client.mjs`: Codex's
  `discoverNativeSessions` proves the daemon's pid from its PID record with `ps` and `lsof`, lists
  loaded threads by metadata only, keeps idle threads that are not subagents or ephemeral, and
  keeps those whose directory runs ACC's `sessionStart`, `sessionEnd` and `userPromptSubmit`
  hooks enabled and trusted or managed.
- `packages/hook-runner/src/runner.mjs`: `registerNativeSession` runs `SessionStart`'s own
  handler under the per-session lifecycle lock with the daemon's pid handed over and no pin,
  and skips a chat that already has a binding or resolves to another workspace.
  `registerDiscoveredSessions` asks every installed adapter that can discover and registers what
  it found, within one budget.
- `packages/cli/src/main.mjs`, `doctor-command.mjs`, `packages/mcp-server/src/server.mjs`,
  `bin/entrypoints/acc.mjs`, `acc-mcp.mjs`: status, doctor and the MCP status tool register
  before they read. A failure never fails them.

## Tests

- `packages/adapter-codex/test/native-discovery.test.mjs`: the candidate on a verified daemon,
  with metadata-only reads and `hooks/list` asked for its directory; subagents, ephemeral, busy
  and unloaded threads left out; untrusted, modified, disabled, missing and foreign hooks left
  out, managed hooks accepted; nothing without a proven pid, socket or readable hooks.
- `packages/hook-runner/test/register-native-session.test.mjs`: registration names the
  participant the hook would, hands the pid to the native binding and writes no pin; the chat's
  first real hook resumes the registered session; a bound chat is left alone; the caller's
  `ACC_PARTICIPANT` never names the chat; another workspace is refused; discovery registers once,
  asks no uninstalled adapter and survives one that fails.
- `packages/cli/test/delivery-routing.test.mjs`: status calls registration with its workspace
  and data home before it reads, and succeeds when registration fails.

All three files failed with the implementation removed and pass with it.

## Real client

On 2026-09-29, against the running daemon with ACC 0.8.3 installed, a new Codex TUI was
opened in a pseudo-terminal and nothing was typed:

- The worktree's discovery took 198 ms and returned only that thread. The maintainer's own
  active chat and its subagent in the same daemon were left out.
- The worktree's `status`, composed as `bin/entrypoints/acc.mjs` composes it, registered
  `codex-l_7tsX` (`session.opened` at 05:21:04.6Z). The installed 0.8.3 `acc status` listed it
  `online` with a current live binding; `acc doctor` printed `local transport active; receiver
  verified`.
- A request from a Claude Code session at 05:21:29.3Z was offered through `codex-app-server`
  0.5 s later. The chat's first turn, run by the installed 0.8.3 hooks, answered `OK` at
  05:21:46.3Z from the registered session; no second `session.opened` was recorded.
- Ctrl-C at 05:22:15Z; `session.closed` at 05:23:16.4Z.

MCP `acc_status` shares the composition but was exercised only by the existing MCP suite.

## A review finding the first candidate had

The pull request review found that `registerDiscoveredSessions` awaited each adapter's
discovery with no bound of its own: an adapter that ignored its timeout would hold `acc status`,
`acc doctor` and MCP `acc_status`. Codex's discovery had the same gap inside, since its `ps` and
`lsof` checks ran before its peer timeout, with the command runner's 20-second default. Now
each adapter's answer is raced against the remaining budget, Codex's whole discovery is raced
against its timeout, and every process check it starts carries that timeout. Tests for a
discovery that never answers, a `ps` that never answers, and the timeout on each process check
failed before the fix and pass after it.

## Suite

`npm test` on the candidate commit `b88201b`, run under `env -i` with only `HOME`, `USER`,
`TMPDIR` and a PATH of system directories plus node, as in CI: 2,749 tests, 2,748 passing,
0 failing, 1 skipped. The skipped test is the existing uninstall check that skips on a machine
where Gemini CLI is installed, as on `main`. Nothing was re-run. The first candidate, `667389c`,
had passed 2,746 tests the same way.

## Exact local artifact

- Source: clean commit `71eada2b95694fea98426da855827836a8370ac4` on
  `feat/codex-empty-chat-registration`, merging `main` at `b478c02` (after #225).
- Archive: `agents-can-communicate-0.8.3.tgz`, packed from that commit.
- Size: 493,489 bytes; 318 packed entries.
- SHA-256: `618479431f726086b80c72fd39ba1f0b4241461e6f2227c1b1eb80a3b6cc3ef5`.
- Package version remains `0.8.3`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
