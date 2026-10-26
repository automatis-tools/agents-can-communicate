# Development artifact: a refused state write is named as such

Captured on October 26, 2026, with Node 26.5.1 and Codex CLI 0.164.0 on macOS arm64. This is an
unpublished development artifact, built from `78f586439316d3a93ae07f6100d55b5eec43ae95`. The package version remains
`0.12.1`, and existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.12.1.tgz` |
| Packed size | 620,751 bytes |
| Files | 380 |
| sha256 | `110aa5a0e93cd44e2cf1438aea47c041c97c014b34dc7fdacdf41f9be3205297` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified that exact
archive and reported PASS. No package was published.

## Before the change

Released 0.12.1 was installed in an isolated home and data home, and `acc install --adapter
claude_code --delivery off` set up its managed runtime. Under `sandbox-exec` with writes
denied below the data home:
- `acc status --json` and `acc message` exited 4 with `runtime unavailable; retry after the
  update or run acc update to recover`;
- `acc doctor --json` reported `workspaceInspection: unavailable_during_update` with phase
  `ready` and no pending update.

Admission's first refused write was an `fchmod` of the runtime directory (`EPERM`), as #316
recorded in ChatGPT Work Mode.

## The installed candidate

The same setup with this archive:
- `acc status --json` and `acc message` exited 4 with
  `cannot write ACC's state: fchmod <data home>/acc/runtime was refused (EPERM); the runtime
  is ready and no update is pending`, followed by the guidance to run ACC where its data home
  is writable, and `reasonCode: state_access_denied`.
- `acc doctor --json` reported `scope: runtime`, `workspaceInspection: state_access_denied`,
  the refused `fchmod` and phase `ready`.
- A Claude Code hook exited 0 with
  `acc: coordination unavailable: cannot write ACC's state (EPERM); session may continue`.

## Real Codex 0.164.0

The archive was installed with real Codex 0.164.0 in an isolated short home, with a data home
outside the sandbox's writable paths:
- With ACC's rules file, `codex exec` in `workspace-write` sent a message and took a claim
  through ACC's wrapper.
- With the rules file moved away, the same send printed the refused `fchmod` and the ready
  runtime, and stored nothing. Before this change, it printed the unfinished-update text.
- Uninstall restored `config.toml` byte for byte. The Codex service that the run started and
  the isolated directories were removed afterwards.

## Limits

- ChatGPT Work Mode was not driven. The text it would now show is the one above, because its
  denial is the same `fchmod` refusal. Whether a supported ACC path exists inside that host
  remains open in #316.
- The end-to-end tests make the runtime directory immutable with `chflags uchg`, which is
  macOS's. The classification and the texts are unit-tested on every platform.
