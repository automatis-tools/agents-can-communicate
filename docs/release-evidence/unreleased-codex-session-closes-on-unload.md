# Unreleased: a closed Codex TUI closes its session

## What was measured

Issue #212 suspected that a Codex session whose TUI was killed stays open until the 24-hour
presence expiry, because its recorded pid is the long-lived app-server daemon's. A comment on
2026-09-28 added that an ordinary Ctrl-C exit also left the session open.

On 2026-09-29 (macOS arm64, ACC 0.8.3, Codex CLI 0.158.0) real TUIs were driven in a
pseudo-terminal from the repository directory. Each was registered through a queued prompt
that started one turn, and the ACC event log was read:

| TUI exit | Exit | `session.closed` | Delay |
|---|---|---|---|
| Ctrl-C twice after a turn | 03:51:31.4Z | 03:52:31.97Z | 60.6 s |
| `kill -9` after a turn | 03:55:18Z | 03:56:18.8Z | 60.8 s |
| Ctrl-C with no turn | 03:56:43Z | SessionEnd hook process at 03:57:43Z | 60 s |

The daemon unloaded each thread within five seconds of the close, as a `thread/loaded/list`
poll showed. The session records named the daemon's pid.

The 2026-09-28 observation had run `codex archive` at 22:55:41Z, 60 seconds after the Ctrl-C at
22:54:42Z; the recorded close at 22:55:42Z coincided with the unload the timer caused.

## What changed

Documentation only: `packages/adapter-codex/COMPATIBILITY.md` (the terminal-exit paragraph and a
new measured section), `docs/CONCEPTS.md`, `docs/GETTING_STARTED.md` and `docs/HOW_IT_WORKS.md`,
which said that a daemon thread can receive messages after its terminal exits, now say for
about a minute. No code changed, so no test was added.

## Suite

`npm test` on the candidate commit `522bb1d`, which merges `main` after #225, run under
`env -i` with only `HOME`, `USER`, `TMPDIR` and a PATH of system directories plus node, as in
CI: 2,752 tests, 2,751 passing, 0 failing, 1 skipped. The skipped test is the existing
uninstall check that skips on a machine where Gemini CLI is installed, as on `main`. Nothing
was re-run. Before the merge, `f82c138` had passed 2,734 tests the same way.

## Exact local artifact

- Source: clean commit `522bb1d629b56db59c530dcd4704787afb324e0c` on
  `fix/codex-session-closes-on-unload`, merging `main` at `b478c02` (after #225).
- Archive: `agents-can-communicate-0.8.3.tgz`, packed from that commit.
- Size: 489,766 bytes; 317 packed entries.
- SHA-256: `21470ad09afe7a05149ed5ac6de012300e7bb33908d2cb46a0c7a1025dae6d75`.
- Package version remains `0.8.3`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
