# Development artifact: ACC's Codex profile is available, not the default

Captured on October 26, 2026, with Node 26.5.1 and Codex CLI 0.164.0 on macOS arm64. This is an
unpublished development artifact, built from `d563fce95d7863c08215088e0fd2f68cc9e0d3b5`. The package version remains
`0.12.0`, and existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.12.0.tgz` |
| Packed size | 617,081 bytes |
| Files | 379 |
| sha256 | `aabda0c2642fcf3889654be51cc1ffc5afe4852bc8c708f3bd3e7a02661383fb` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified that exact
archive and reported PASS. No package was published.

## Real Codex, installed package

The archive was installed in an isolated home with an isolated `CODEX_HOME` and a data home
under `~/Library/Caches`, outside the sandbox's writable tmp paths. Then
`acc install --adapter codex --delivery actionable` ran with real Codex 0.164.0.

- `config.toml` holds `default_permissions = ":workspace"`, ACC's `acc-workspace` profile
  and the managed block. The install preview said: "ACC's rules file runs its commands
  outside the Codex sandbox, so new chats keep their usual mode." Doctor reported outgoing
  delivery as configured, through the rules file.
- A `codex exec` session (approval `on-request`, auto-review, sandbox `workspace-write`)
  ran ACC's own wrapper, `acc-cli.sh message …`, for a CLI participant. ACC recorded the
  message, and history held it.
- Control: the same with ACC's rules file moved away. The command exited 4, ACC stored
  nothing, and the message read
  `runtime unavailable; retry after the update or run acc update to recover`.
- The isolated directories and the Codex daemon that the isolated install had started were
  removed afterwards.

## The maintainer's config

The maintainer's `config.toml` from before the recovery on 2026-10-26 was sorted and had no
comments. Run against it, `adoptUnmarked` recognised all seven of ACC's entries:
- the marketplace and the plugin;
- the four profile tables;
- `default_permissions = "acc-workspace"`.

With them removed, the registration conflict that failed the 0.12.0 update is gone. The
current, marked config adopts nothing.

## Limits

- The capture names Codex 0.164.0 on macOS. ACC applies it from 0.164.0 onward on every
  platform with a rules file.
- Windows, a foreign or edited rules file, and older Codex keep the previous selection.
- Codex Desktop was not driven; its menu reads the same `default_permissions`.
- The misleading `runtime unavailable` text in the control run is a separate, pre-existing
  message about a sandbox denial.
