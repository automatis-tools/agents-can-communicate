# Development artifact: the Codex 0.164.0 daemon is verified

Captured on October 26, 2026, with Node 26.5.1 and Codex CLI 0.164.0 on macOS arm64. This is an
unpublished development artifact, built from `9aa45d40d63d2e85e2d958668e8d2e02637c60e2`. The package version remains
`0.12.0`, and existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.12.0.tgz` |
| Packed size | 614,041 bytes |
| Files | 378 |
| sha256 | `a37eecec4866ce6303ae2006ff956a641c4598b23c4b87f57e39c2f8d455cb27` |

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
`ready`.

## Limits

- The capture names Codex 0.164.0 on macOS. The Windows command-line shape is covered by a unit
  test only.
- Live delivery into a loaded chat was not part of this capture. The native probe passes before
  the identity check runs, so that path did not depend on it.
