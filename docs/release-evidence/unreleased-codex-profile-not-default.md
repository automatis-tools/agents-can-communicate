# Development artifact: ACC's Codex profile is available, not the default

Captured on October 26, 2026, with Node 26.5.1 and Codex CLI 0.164.0 on macOS arm64. This is an
unpublished development artifact, built from `21749c351f97e99de36638c4a74ba4f5cf524c3e`. The package version remains
`0.12.0`, and existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.12.0.tgz` |
| Packed size | 618,623 bytes |
| Files | 379 |
| sha256 | `a3ea6ae5e9cc2a83dad384880411b85435091e3b0a35458aa7f64cb0afb96cdf` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified that exact
archive and reported PASS. No package was published.

## Real Codex, installed package

The archive was installed with npm into an isolated prefix. Each case had its own home and
`CODEX_HOME` under `~/Library/Caches`, short enough for Codex's control socket, and its own
data home outside the sandbox's writable paths. `acc install --adapter codex --delivery
actionable` ran with real Codex 0.164.0. Each `codex exec` session ran with approval
`on-request`, auto-review and sandbox `workspace-write`, and ran ACC's own wrapper first and
alone.

A config that selected no mode:
- After install, `config.toml` held `default_permissions = ":workspace"` inside ACC's
  selection block, ACC's `acc-workspace` profile and the managed block. The install output
  said: "Your config selects no mode, so ACC sets default_permissions = ":workspace", Codex's
  workspace mode: a defined profile needs a selection." Doctor reported: "ACC's rules file
  runs its commands outside the Codex sandbox; the acc-workspace profile is available for a
  chat that selects it."
- `acc-cli.sh message …` from `codex exec` was recorded, and history held it.
  `acc-cli.sh claim --resource 'file:e2e/**' …` was recorded, and status held the claim.
- Control: the same send with ACC's rules file moved away. ACC stored nothing, and the
  command printed `runtime unavailable; retry after the update or run acc update to recover`.
- `acc uninstall --adapter codex` restored `config.toml` byte for byte.

A config whose last line was `sandbox_mode = "workspace-write"`, with no newline:
- Install moved that line into ACC's block and selected `default_permissions = ":workspace"`
  there. The install output said: "ACC keeps your workspace mode, written as
  default_permissions = ":workspace", and restores your own line on removal."
- The message and the claim from `codex exec` were recorded. During that run, Codex appended
  its own `[projects."…"]` trust table after ACC's blocks.
- Uninstall restored the user's line on a line of its own, followed by Codex's table.

On a fresh `CODEX_HOME` whose Codex service had never run, `acc install` exited 4 with
`Codex service preparation could not verify daemon_identity_unavailable`. Released 0.12.0
(sha256 `70b62881…9da6a8`) does the same in the same setup, so this branch did not cause it.
A second install, with the service running, exited 0. This is #331, fixed separately in #332.

The isolated directories and the Codex services the isolated homes started were removed
afterwards.

## The maintainer's config

The maintainer's `config.toml` from before the recovery on 2026-10-26 was sorted and had no
comments. Run against it with the socket list ACC grants on this machine, `adoptUnmarked`
removed 17 statements:
- `default_permissions = "acc-workspace"`;
- the marketplace and the plugin tables;
- the four profile tables, with the state directory and the four sockets ACC grants.

With them removed, the registration conflict that failed the 0.12.0 update is gone. The
current, marked config adopts nothing.

## Limits

- The capture names Codex 0.164.0 on macOS. ACC applies it from 0.164.0 onward on every
  platform with a rules file.
- Windows, a foreign or edited rules file, and older Codex keep the previous selection.
- Codex Desktop was not driven; its menu reads the same `default_permissions`.
- The misleading `runtime unavailable` text in the control run is a separate, pre-existing
  message about a sandbox denial.
