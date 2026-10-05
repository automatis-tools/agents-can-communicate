# Unreleased: the desktop apps of Antigravity, Claude Code and Codex

| Candidate artifact | Value |
|---|---|
| Built from | `9cd6cb873a85a15c914a178d9421ddde5b3be795` |
| Tarball | `agents-can-communicate-0.8.5.tgz`, 553,139 bytes, 336 files |
| sha256 | `d45d7624f16d0b96ab9a44e6ce3fa0522dcae7f2420dd277b044883d870c119b` |

Design: [2026-10-04-desktop-clients](../design/2026-10-04-desktop-clients.md). Follows issue
#171, whose reporter pushed into a desktop Antigravity conversation with the language server's
own token.

## What was measured before the change

ACC 0.8.5 installed, macOS 27.0 arm64, 2026-10-04.

- **Antigravity 2.19.1, the desktop app.** It runs `~/.gemini/config/hooks.json` under its
  language server, with no `agy`. ACC attached the conversation with `clientPid: null` and
  `clientVersion: 1.2.16` - the `agy` on `PATH` - and every live attempt read
  `degraded / client_process_unknown`. The agent's tool shell has the endpoint variables but
  runs in a sandbox where `ps` and ACC's wrapper fail, so the relay cannot start there. A push
  with the server's own token and HTTP port woke an idle conversation within a second
  (`packages/adapter-antigravity/fixtures/desktop-2.19.1.json`).
- **Claude Code in Claude.app (Local).** A session ran Claude.app's own build, 2.1.286; the
  binding said 2.1.289, the `claude` on `PATH`. Live delivery worked unchanged: an idle session
  woke, and the model answered with `acc reply` in ten seconds.
- **Codex in ChatGPT.app 26.928.** Each window runs a private app server over stdio
  (openai/codex#41014). ACC attached its chats and recorded every live attempt as
  `handshake_failed`.

## What changed

- `adapter-sdk`: `client.variants`, `identifyClientProcess(entry)` and
  `clientVersionOf({ pid, entry, env })`; evidence and native anchors may name a variant;
  `capabilityEvidence` reads the variant's own evidence; each delivery protocol is judged from
  its own first capture.
- `hook-runner`: the session's product and version come from the client that runs it - its
  command line, the adapter's reading, its own executable, then `PATH`; the binding carries
  `clientName`. A turn whose bound client has exited binds the session to the client running
  now.
- `adapter-antigravity`: the desktop app's language server is the `antigravity-desktop` client;
  `desktop-endpoint.mjs` and `desktop-delivery.mjs` bind and deliver through it, reading the
  token at each use and never storing it; no relay ask for the desktop; install adds the
  wrapper's grant to `~/.gemini/config/config.json` when the app has created it. Evidence:
  hooks and next turn at 2.19.1, live push from the product capture below.
- `adapter-claude-code`: the version comes from the session's registry record.
- `adapter-codex`: the Codex app's own server, `codex [-c …] app-server` with no `--listen` from
  inside an app bundle, is `client_session_embedded`, told once with nothing to change.
- `cli`: doctor names a desktop session by its product, and stops telling Codex app users to
  start another chat there.
- Docs: capabilities, getting started, README, adapter authoring, security model,
  troubleshooting, three compatibility notes. README and getting started no longer say live
  delivery is Apple Silicon only; CAPABILITIES no longer says ACC never takes the Antigravity
  token.

## Tests

Each new test was seen failing for its stated reason before the change that made it pass.
Highlights:

- `packages/adapter-sdk/test/client-variants.test.mjs`,
  `native-variant-contracts.test.mjs`: a variant is judged by its own evidence and its own
  protocol floor, never by the primary client's.
- `packages/hook-runner/test/running-client-identity.test.mjs`: version precedence, the
  binding's `clientName`, and the restart rebind (from the D06 failure below), including a
  session that closed while its client was down (from the PR review).
- `packages/adapter-antigravity/test/desktop-delivery.test.mjs`: bind, refresh, offer, a
  restarted server refused, and the token absent from every file under the data home.
- `packages/adapter-codex/test/desktop-host.test.mjs`: pinned to the command line ChatGPT.app
  actually ran - the first version of the check looked for `app-server` as the first word and
  missed it there; reading the real process caught it.

## End to end after the change

Antigravity 2.19.1, the real desktop app, 2026-10-05. A private candidate from this branch,
packed as 0.8.99 so the managed runtime took it (sha256 `c03096251a9e…`), installed into an
isolated data home, the app launched with that data home. Six cases, all passed
(`fixtures/delivery/antigravity-desktop-2.19.1-product.json` and its evidence):

- D01: an idle conversation woke in about a second, no user input.
- D02: a push accepted six seconds into a 4,113-character answer was shown after it,
  uninterrupted.
- D03: the woken agent's `acc reply` ran on the model's retry outside the sandbox with no
  approval prompt, the wrapper's grant being in `config.json`.
- D04: a message resent with the same client message id reached the model once.
- D05: with the app quit, the message stayed queued as `recipient_offline`.
- D06: after a restart, the conversation's first turn bound it to the new server and the next
  push woke it. D06 failed on the first candidate - the session stayed bound to the exited
  server - which led to the hook runner's restart rebind.

The Claude change was read against every live session on the machine: five sessions, the
version each registry record names (2.1.284 to 2.1.288, the Claude.app one 2.1.286), where
`PATH` said 2.1.289 for all. The Codex detection was read against the live ChatGPT.app server.

**What the run did to the maintainer's machine.** Swapping candidates, an `acc uninstall`
without `--adapter` under the isolated data home removed ACC's integrations for Claude Code,
Codex, Gemini CLI, Grok and Antigravity from the real client homes, although that data home
had installed Antigravity alone. The real `acc install` put them back from the real data
home's records. Gemini CLI's files matched a sha256 manifest taken that morning and
`~/.gemini/config` matched the pre-run backup, byte for byte; Claude Code, Codex and Grok were
checked with `acc doctor` only. That uninstall behaviour is a separate defect.
