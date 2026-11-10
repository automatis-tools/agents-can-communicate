# Live delivery on by default: development evidence

This records the development candidate for turning live delivery on by default. It is not a
published release.

## Exact artifact

- Source: clean commit `66ec99a79920b277c14943d380306ca72812770c`.
- Archive: `agents-can-communicate-0.14.1.tgz`, 656,097 bytes, 390 files.
- SHA-256: `bc40bb7be6f560fe8f19cadd3588aca8377dc585fd244ef52405d38d75ba023f`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Behaviour covered by tests

- With no `--delivery`, a client that can receive live delivery gets `actionable` and a
  `default-enabled` decision. No run asks a question.
- An off from `--delivery off` or from the old interactive "No" stays. An off that ACC recorded,
  or an off with no coherent record of a choice, turns on once the client can receive delivery.
- A managed update applies the same rule. When that turns Kimi on, the Codex profile written in
  the same refresh carries the `127.0.0.1` rule.
- A service the default cannot start is reported and does not fail the install. A service
  requested with an explicit `--delivery` still fails it.
- A sender refused by Antigravity's relay socket with `EPERM` or `EACCES` gets
  `transport_permission_denied`, on an offer and on a lease refresh. Any other connection error
  stays `transport_error`.
- The install's delivery note names a client only after that client's install succeeded.

## Real clients

Claude Code 2.1.321, Codex CLI 0.167.0 and Antigravity CLI 1.5.3 ran on macOS arm64 in an isolated
home and data home. Plain `acc install`, with no `--delivery`, recorded `default-enabled` and
`actionable` for all three and asked nothing.

### Three-window deploy lane, first candidate

Five runs from clean clones of the public demo, on commit
`f826841a51b69ccb5ff112f1d198ee53747a3bb8`. Each session held one finished feature, and one
sentence to Claude Code started the release.

| Run | Deploys live | Collisions | Seconds | Load at start |
|---|---|---|---|---|
| 1 | 3 | 0 | 229 | 88 |
| 2 | 3 | 0 | 198 | 192 |
| 3 | 3 | 0 | 170 | 62 |
| 4 | 3 | 0 | 206 | 59 |
| 5 | 3 | 0 | 192 | 123 |

Nine offers failed across those runs, and Codex sent every one, from its default workspace
sandbox:

- Five were `transport_permission_denied` on the Claude Code inbox socket. Codex retried through
  approved execution. Three retries woke Claude Code. The other two ran after the run's Claude Code
  session had closed, and the message stayed queued.
- Four were `transport_error` on Antigravity's relay, and Codex received no retry instruction.
  Two messages reached Antigravity on its next turn, and two were still queued when the run ended.

### Antigravity relay refusal, commit `7d749c7a`

Inside Codex's sandbox with `default_permissions = ":workspace"`, connecting to a listening socket
in `/private/tmp/acc-ch-501` returned `EPERM`. The same connection succeeded with the
`acc-workspace` profile and outside the sandbox.

On commit `7d749c7a3f06f52573cec668b35490a15ec9a02d`, an idle Antigravity session and a Codex
session ran in the same clone, and Codex was asked to send an ACC request:

1. The first attempt recorded the message and printed that the live offer was blocked by sender
   permissions. The store shows `offer_failed` with `transport_permission_denied`.
2. Codex retried through approved execution. Eleven seconds after the failure, the store shows
   `offer_succeeded` on the relay.
3. The idle Antigravity session woke with no user input and answered 12 seconds later.

The three-window scene then ran once more on that commit: 3 deploys live, 0 collisions,
202 seconds, load 100 at the start. The exact artifact adds one commit after it, which limits the
install's delivery note to clients that installed.

## Limits

- Every Codex send to Claude Code or Antigravity starts inside the sandbox, so a live wake costs a
  refused attempt and an approved retry. The rules file did not carry these commands out of the
  sandbox on Codex 0.167.0.
- Kimi Code and the Claude Code bypass-permissions wake were not part of these runs.
- Windows and Linux ran the automated suite only.
