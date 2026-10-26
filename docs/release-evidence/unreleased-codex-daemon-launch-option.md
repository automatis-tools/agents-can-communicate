# Development artifact: the Codex 0.164.0 daemon is verified

Captured on October 26, 2026, with Node 26.5.1 and Codex CLI 0.164.0 on macOS arm64. This is an
unpublished development artifact, built from `98900b81782e7cebd360084486d0a202d4a7b2af`. The package version remains
`0.12.0`, and existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.12.0.tgz` |
| Packed size | 614,044 bytes |
| Files | 378 |
| sha256 | `c971a79a4f2648c1fb6161c8a6a8683c1a6596d9bd9b11443eb30748c064f7a1` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified that exact
archive and reported PASS. No package was published.

## Real Codex, installed package

The archive was installed with npm into an isolated prefix. The home and `CODEX_HOME` were
fresh, under `~/Library/Caches`, with no Codex service ever started there.

- `acc install --adapter codex --delivery actionable` started the service and exited 0 with
  "installed 1 adapter(s)". Released 0.12.0 in the same setup reported "1 failed",
  `daemon_identity_unavailable`, and exited 4.
- `acc doctor` exited 0. It reported that the service has no loaded client session, which is
  the expected state without an open chat.
- A second install exited 0 with no failure line, and `acc uninstall --adapter codex` restored
  `config.toml` byte for byte.
- The isolated directories and the Codex service that the install started were removed
  afterwards.

## The maintainer's daemon

A read-only maintenance inspection ran against the maintainer's own Codex service, in the
standalone layout, whose daemon runs with `--analytics-default-enabled --managed-daemon`. The
code before this change reported `daemon_identity_unavailable`, and this change reported
`ready`. Chat discovery against the same service, also read-only, found no chats before this
change and one chat with it.

## Limits

- The capture names Codex 0.164.0 on macOS. The Windows command-line shape is covered by a unit
  test only.
- Live delivery into a loaded chat was not part of this capture. Its native probe passes before
  the identity check runs, so that path did not depend on the check. Discovery runs the check
  first, which is why it found no chats before this change.
