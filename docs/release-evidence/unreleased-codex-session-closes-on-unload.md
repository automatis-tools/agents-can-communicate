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

`npm test` on the candidate commit `f82c138`, run under `env -i` with only `HOME`, `USER`,
`TMPDIR` and a PATH of system directories plus node, as in CI: 2,734 tests, 2,733 passing,
0 failing, 1 skipped. The skipped test is the existing uninstall check that skips on a machine
where Gemini CLI is installed, as on `main`. Nothing was re-run.

## Exact local artifact

- Source: clean commit `f82c1387c864d60c23eb95284fa4be6081a0a0c6` on
  `fix/codex-session-closes-on-unload`, from `main` at `3051920` (0.8.3).
- Archive: `agents-can-communicate-0.8.3.tgz`, packed from that commit.
- Size: 486,785 bytes; 315 packed entries.
- SHA-256: `ef5d4f4ecf598a3894423ce0827c6b71fea88064c56246aced36be6a8136337a`.
- Package version remains `0.8.3`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
