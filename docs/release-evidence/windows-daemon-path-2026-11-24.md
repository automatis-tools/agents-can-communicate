# ACC accepts the Codex daemon on Windows when its path mixes separators: development evidence

This records the fix for #449 and its development candidate. It is not a published release.

## Cause

After ACC starts the Codex app-server daemon, it asks `codex app-server daemon version` which
executable and socket the daemon uses, and compares both with the paths ACC expects. The
comparison was exact text. ACC builds its paths with `path.join`, so on Windows they contain
backslashes only. Codex 0.165.0 reports the executable of the daemon package it installs itself
with both separators:

```text
D:\a\_temp\su\temp\acc-v02-packed-kfmkHy\home\.codex\packages/app-server-daemon\current\bin\codex.exe
```

The two strings name the same file, but they differ, so `acc install` refused the running daemon
with `daemon_identity_unavailable`, and Codex live delivery on Windows never became ready.

On Windows the comparison now normalizes both paths with `path.win32.normalize`, which reads `/`
as `\`, as Windows does. Any other difference still refuses the daemon. On POSIX the comparison
stays exact, because a backslash is part of a file name there. The pid file, the process command
line and the real path of the executable are still checked as before.

## Measurement on GitHub's Windows runner

On 2026-11-24 the live check of #251 ran as a standard local user on `windows-latest` with
Codex 0.165.0 and a fresh Codex home. ACC started the daemon and refused it. At that moment:

- `codex app-server daemon version` reported `status: running`, `backend: pid`, the
  `managedCodexPath` above, and the socket path with backslashes only;
- `daemon.pid` named the running process;
- the process command line was the self-installed release
  `packages\app-server-daemon\releases\0.165.0-x86_64-pc-windows-msvc\bin\codex.exe` with
  `app-server --listen unix:// --analytics-default-enabled --managed-daemon`.

## Development candidate

- Source: clean commit `d5f4ff42a1025203a9c4513190e24273e9b6f438`.
- `agents-can-communicate-0.15.4.tgz`, 675,293 bytes, 398 files.
- SHA-256: `879f3820898345fa8a418790bddc29df1b9508ec02ea8962e07b80c196441c64`.
- The exact archive passed `scripts/verify-package.mjs`.

## Tests

`packages/adapter-codex/test/service-path.test.mjs`:

- on Windows the path Codex 0.165.0 reports equals the expected one; it failed with the exact
  comparison;
- on Windows a path to another file, an empty value or a non-string is refused;
- on POSIX a backslash or a trailing separator makes the paths differ.

The end-to-end check through the Windows daemon as a standard user is #251.
