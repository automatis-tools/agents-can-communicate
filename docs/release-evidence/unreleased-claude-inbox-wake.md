# Unreleased Claude Code inbox wake

Issue #130. ACC reached a busy or idle Claude Code session through the research-preview
Channels path: a `claude` shim on `PATH`, a development-channel flag, a Channel MCP server,
Anthropic authentication, and an organization setting on Team and Enterprise plans. This build
wakes the session through the inbox socket every Claude Code session binds, and delivers the
message through the next-turn hook that the wake fires.

## Transport capture, before any ACC code used the inbox

Claude Code 2.1.282, macOS arm64, 2026-09-25. A receiving TUI session in `auto` mode, with ACC
0.7.0 hooks and no Channel. A separate process wrote one JSON line per connection to the socket
the session registry named, with no auth line and no token.

| Observation | Result |
|---|---|
| Idle session | A new turn started with no user input. |
| Busy session, three sequential Bash calls | The frame was taken after the first call returned and before the second. The turn continued. |
| `UserPromptSubmit` | Fired for every delivered frame, idle and mid-turn. |
| ACC question, frame with ACC text only | The `beforeTurn` projection showed the question in its untrusted block. The model ran `acc reply`. The store recorded the answer and `acknowledged`. |
| Sender attests `from-mode="bypass"`, prompting receiver | Held with an approval dialog. Registry status `waiting`. Deny dropped the frame. |
| Six frames from six processes | All delivered. Five queued frames reached the model in one turn, each with its own `UserPromptSubmit`. |

Redacted record: `packages/adapter-claude-code/fixtures/inbox-wake-2.1.282.json`.

## Product capture of the installed candidate

`scripts/e2e/claude-inbox-candidate.mjs` built a private candidate from this branch (package
SHA-256 `fa81c55588988ed7274636c564a0adb5c442110f014f82e7a3f94da26fdd8891`) that enables the
inbox contract on the transport anchor. It was installed with an isolated ACC data home. The
plugin registration in the real Claude config directory was backed up first, and all 23 files
were restored byte for byte afterwards. Two Claude Code 2.1.282 TUI sessions ran in one
workspace, in `auto` mode, model Sonnet 5.

`scripts/e2e/claude-inbox-product.mjs` derived every observation from `acc message --json`,
`acc sync --scope full --json` and the receiving session's transcript records:

| Case | Observations | Outcome |
|---|---|---|
| C01 idle | delivery `woken`, wake `started-turn`, projection `body-shown`, offer `next-turn` | passed |
| C02 busy | delivery `woken`, wake `between-tool-calls`, projection `body-shown`, offer `next-turn` | passed |
| C03 reply | answer `recorded`, receipt `acknowledged` | passed |
| C04 duplicate | logical message `same-message-id`, wake `delivered-once` | passed |
| C05 fallback | client `exited`, delivery `queued` | passed |
| C06 exact binding | delivery `woken`, wake `started-turn`, other session `not-woken` | passed |

Capture and product evidence: `packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.282.json`
and `claude-code-2.1.282-product-evidence.json`. The capture's limitations name what it did
not cover: a receiver in `bypassPermissions` mode, `darwin-x64`, Linux and native Windows.

## Upgrade from 0.7.x

`tests/acceptance/managed-update-degraded-packed.test.mjs` lays out what 0.7.x wrote for a live
Claude install: the Channel activation record, the `claude` shim and its `~/.zshrc` block, the
`acc-channel` `.mcp.json`, the `acc-bootstrap` and `acc-claude-channel` launchers, and the
bootstrap cache. A packed `acc update` with a client whose inbox probe fails removes every one
of them, keeps the recorded `actionable` consent and leaves no modified owned file. A later
`acc install` on a client that carries the inbox records the `claude-code-inbox-socket-v1`
activation.

`tests/process/legacy-shim-fails-open.test.mjs` runs a 0.7.x shim, rendered by that version's
own code, against a removed launcher and against the retired entrypoint stub. Both launch the
plain vendor command with its arguments byte for byte, without the development-channel flag.

A 0.7.x updater checks that a downloaded package has an entrypoint for each of its own entry
kinds. `packages/cli/test/managed-runtime-retired-kinds.test.mjs` pins that this package still
ships `acc-bootstrap` and `acc-claude-channel` entrypoints, as stubs.

## Candidate archive

`node scripts/verify-package.mjs` on `34e24396a2d9b3065b0c1eae8b8c0a25f3002e3a`, after the
review fixes (a refused or late handshake retires the endpoint it wrote; install and update
sweep crashed Channel registrations):

```text
== pack
   ok  agents-can-communicate-0.7.1.tgz  452 KB
   ok  sha256 04088ef7aeaa0974b97e89ffff6b10bc24af80111034968bae2a48d3625b3e35
== tarball contents
   ok  310 entries, none forbidden
   ok  6 certification manifest(s), exact evidence allowlist shipped
   ok  every packed Markdown link resolves inside the tarball
== install into a clean directory
   ok  acc, acc-hook, acc-mcp
== doctor
   ok  6 adapter(s) reported
== a workspace with no Git
   ok  1 participant(s), 1 claim(s)
   ok  nothing written into the project
== install and uninstall
   ok  client-home topology, modes, links, and bytes restored; repeated uninstall was a no-op
PASS
```

## Test suite

`npm test` on `8ad1b9b` (the recorded candidate plus its CHANGELOG record): 2538 tests, 2537
passing, 1 skipped, 0 failing.
