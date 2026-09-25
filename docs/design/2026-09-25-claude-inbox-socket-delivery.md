# Claude Code live delivery through the session inbox socket

Issue #130. ACC reaches a busy or idle Claude Code session through the research-preview
Channels path today. This design replaces it with the inbox socket that every Claude Code
session since 2.1.224 binds by default. The socket carries only a wake; the message itself
arrives through the `UserPromptSubmit` projection that ACC already ships.

## Problem

The Channels path needs four things from the user's machine:

- a `claude` shim early on `PATH` that adds `--dangerously-load-development-channels
  plugin:agents-can-communicate@acc-local` to every launch;
- a channel MCP server (`acc-claude-channel.mjs`) that Claude spawns per session and that
  holds a Unix endpoint and a lease;
- Anthropic authentication, because Channels are unavailable on Bedrock, Vertex and Foundry;
- on Team and Enterprise plans, an organization owner who enables `channelsEnabled`.

The vendor labels Channels a research preview whose protocol "may change". The shim is also
the one caveat on ACC's "works inside the session you already opened" claim.

Claude Code 2.1.224 and later bind a per-session inbox socket with nothing to enable, on every
provider. The vendor documents it as the target for "a script or hook to post into a session".

## Evidence

Live capture on 2026-09-25, Claude Code 2.1.282 (darwin-arm64), ACC 0.7.0, receiver in `auto`
mode, no shim and no channel. The full record is in the #130 issue comment. The facts that
decide this design:

1. A frame from an unrelated process, with no auth line and no token, wakes an idle session
   and starts a turn.
2. A frame that arrives during a turn is queued and delivered after the current tool call
   returns. The turn is not interrupted.
3. **Every delivered frame fires `UserPromptSubmit`, including mid-turn.** ACC's `beforeTurn`
   hook ran for each one.
4. With a frame that carried ACC text only, the `beforeTurn` projection showed the queued ACC
   question in its untrusted block, the model answered with `acc reply`, and the store
   recorded the answer and `acknowledged`. This worked idle and mid-turn with no ACC change.
5. A frame whose sender attests `from-mode="bypass"` is held with an approval dialog in a
   prompting-class receiver. A bypass-class receiver holds a frame whose sender does not
   attest bypass (vendor documentation and 2.1.282 binary strings).
6. Frames from separate processes are not deduplicated against each other. Frames queued
   during one turn reach the model in one turn, and each fires `UserPromptSubmit`.
7. `sessionId` in `~/.claude/sessions/<pid>.json` equals the hook input `session_id`, and the
   record carries `messagingSocketPath`.

## Decisions

Recorded on #130 with the maintainer:

- Replace the Channels path completely. The condition "keep Channels for Claude Code before
  2.1.224" does not apply, because the Channels path already requires 2.1.258.
- ACC never attests a permission mode.
- ACC never stores or forwards the receiver's `CLAUDE_CODE_MESSAGING_TOKEN`. A frame with that
  token passes as the session's own child and skips the receiver's inbound controls.

## Design

### 1. The offer is a wake

`offerMessage` connects to the receiver's inbox socket and writes one line:

```json
{"type":"user","message":{"role":"user","content":"<wake text>"},"msg_id":"acc-wake-<messageId>"}
```

The wake text is fixed ACC wording plus the ACC message id:

```text
ACC: new peer message <messageId> for this session. This turn's ACC context shows it. If it
does not, it was already shown, or read it with acc inbox --message <messageId>.
```

The frame carries no subject, no body, no sender name and no peer-supplied byte. Claude Code
wraps it in its own "Another Claude session sent a message" framing, which asks the model to
act on it; the only thing it can act on is an ACC notice. The message itself reaches the model
through the `beforeTurn` projection, inside the untrusted `acc-peer-message` block, with the
existing receipts, budget, repeat rule and `acc reply` route.

The connection sends no auth line. The adapter never reads the receiver's
`CLAUDE_CODE_MESSAGING_TOKEN` and never reads a session `.key` file. The socket answers nothing,
so a wake is accepted when the line was written to a verified socket without an error, inside
the offer timeout.

### 2. The router records a wake as no offer

A successful offer moves the receipt to `offered` today. The projection then treats the body as
already in the model's context and shows at most a breadcrumb
(`packages/adapter-sdk/src/context-projector.mjs:45-52`). A wake carries no body, so that
recording would hide the message on the very turn the wake started.

The native-delivery contract gets one field, `offerKind`: `"message"` (default, today's
behaviour) or `"wake"`. `validateNativeDeliveryContract` accepts only those two values. When the
adapter's contract says `"wake"` and the offer is accepted and passes the version rule, the
router records nothing and returns:

```json
{ "recipientParticipantId": "<id>", "outcome": "woken", "transport": "claude-inbox" }
```

The receipt stays `queued`. The hook records `offered` with `transport: "next-turn"` after its
stdout carried the body, exactly as it does today. That is stronger evidence than a transport
acceptance, and it keeps the store free of new event types and fields: a store written by this
version still validates under 0.7.x.

A failed wake is recorded as a failed offer, as today. `claude-inbox` joins
`NAMED_LIVE_TRANSPORTS`; `claude-channel` leaves it. `acc message` prints
`woke <participant> via claude-inbox; the message arrives with its next turn`. The MCP tools
return the same outcome object.

### 3. The receiver binding

`bindNativeSession({ event, clientPid, clientVersion, runtimeDir, env })`:

1. Requires a positive `clientPid`, a stable `clientVersion` and `event.sessionId`.
2. Reads `env.CLAUDE_CODE_MESSAGING_SOCKET`. Absent means the session has no inbox:
   `native_endpoint_unavailable`.
3. Reads the session registry `<claudeConfigDir>/sessions/<clientPid>.json`, where
   `claudeConfigDir` is `env.CLAUDE_CONFIG_DIR` or `~/.claude`. The record must be a regular file
   owned by this user, with `pid === clientPid`, `sessionId === event.sessionId`, and a
   `messagingSocketPath` whose realpath equals the realpath of the env socket.
4. The socket must be a socket, owned by this user, not a symbolic link, with no group or other
   permission bits.
5. Writes a private endpoint record under `<runtimeDir>/claude-inbox-endpoints/`
   (directory 0700, file 0600, owner checks, atomic rename), the same way the Codex adapter does:
   `{ schemaVersion, endpointId, socketPath, clientPid, sessionId, clientVersion,
   protocolContract, leaseUntil }`. The endpoint id is `claude_inbox_<32 hex>`.
6. Returns the handshake with `modes: ["livePush", "idleWake", "busyQueue"]` and a 120-second
   lease.

`refreshNativeSession({ binding, runtimeDir })` reads the endpoint record and repeats checks 3
and 4 against it. The router calls it when a lease expired, so an idle session stays reachable
between turns. `retireNativeSession` removes the endpoint record. Every `beforeTurn` re-binds, as
it does for Codex.

`offerMessage` resolves the record, repeats checks 3 and 4, then writes the wake. A registry that
disappeared, names another session, or points at another socket gives `recipient_unavailable`.
This check is what stops a wake from reaching a recycled pid.

### 4. Probe, policy and activation

- `probeNativeDelivery` is read-only. It needs a stable version at or above the minimum, a
  platform other than `win32`, and an executable that carries the bytes `messagingSocketPath`.
- The adapter declares `policySource: "installation-record"`, like Codex and Antigravity. The
  policy no longer comes from an environment variable that only the shim set.
- `planNativeActivation` returns one `native-service` mechanism with `serviceId:
  "claude-code-inbox"`, `preExisting: true` and no commands. Claude Code runs the inbox; ACC
  starts nothing and rewrites no argument.

### 5. Contract and certification

- Protocol contract `claude-code-inbox-socket-v1`. `offerKind: "wake"`.
- `delivery: { nextTurn: true, livePush: true, replyRoute: false }`. The reply goes through the
  ordinary `acc reply` path that every adapter has, not through the transport.
- Minimum and anchor: `2.1.282` on `darwin-arm64`, from a new fixture
  `fixtures/delivery/claude-code-2.1.282.json` built from the 2026-09-25 capture (launch mode
  `ordinary-command`, idle `woken`, busy `delivered_between_tool_calls`, reply `acc_reply_cli`).
  A release capture with the packed artifact is required before release, as it was for 2.1.260.
- The Channel evidence rows (2.1.252, 2.1.258, 2.1.260) certified a transport that no longer
  ships. They leave `certification.json`, and their fixtures and `COMPATIBILITY.md` history stay.
- Native Windows is out of scope: it needs an auth line on a named pipe, and it has no capture.
  Hook delivery stays the path there.

### 6. Removal

Removed with the Channels path:

- `packages/adapter-claude-code/src/channel.mjs` and the Channel half of `native-delivery.mjs`;
  `plugin/.mcp.json`; the live branch of `layOutPlugin`; `CHANNEL_ACTIVATION_CHECK`.
- `bin/acc-claude-channel.mjs`, `bin/entrypoints/acc-claude-channel.mjs`,
  `claude-channel-binding.mjs`, `claude-channel-stdio.mjs`.
- `bin/acc-bootstrap.mjs`, `bin/entrypoints/acc-bootstrap.mjs`, and the `acc-bootstrap` and
  `acc-claude-channel` managed-runtime entry kinds and launchers.
- Creation of shell bootstraps: `installShellBootstrap`, `checkNativeBootstrap` and the
  bootstrap cache. Claude is their only user. The `shell-bootstrap` activation kind stays readable
  in install records so that existing records can be retired.
- The `bootstrap-environment` policy source and `ACC_NATIVE_DELIVERY_POLICY`.
- The Channel spikes under `scripts/spikes/` and their tests.

Kept because other adapters use them: `channelSocketDirectory` (Antigravity relay, Codex live
permissions), `resolveClientPid`, the generic MCP `acc_reply`/`acc_ack` tools, and the
`acc-local` marketplace.

### 7. Migration of existing installs

`acc install` and `acc update` leave no part of the Channels path behind:

- A recorded `shell-bootstrap` activation is always retired, even when the plan would otherwise
  keep the previous activation (`packages/installer/src/plan.mjs:125-127`). Retirement uses the
  existing hash-checked `uninstallShellBootstrap`: the `claude` shim and the `~/.zshrc` block go,
  an edited shim or block stays and is reported.
- The plugin is re-laid on every install and update, so the marketplace copy loses `.mcp.json`.
  The retained cache copy of the previous version is removed too, because it still names
  `acc-channel`.
- `writeLaunchers` removes launchers of kinds that no longer exist.
- The bootstrap cache `<dataHome>/acc/native-bootstrap/claude_code.json` and Channel
  registrations `<runtimeDir>/native/claude/*.json` are removed.
- The consent prompt stops asking to "Allow Claude Code development Channels". It asks to allow
  ACC to wake Claude Code sessions through their inbox.

A session started through the old shim keeps its Channel until it exits. Its `beforeTurn`
re-binds to the inbox endpoint on the next turn, so the Channel binding is retired by the
ordinary rebind.

### 8. Inbound controls

ACC never attests a permission mode. A receiver in a prompting mode (default, `auto`,
`acceptEdits`, `dontAsk`) gets each wake. A receiver in `bypassPermissions` holds each wake for
approval until the user approves it or sets `crossSessionInbound: "accept"`. A receiver with
`crossSessionInbound: "refuse"` drops wakes. In every case the message still reaches the model
through the next `beforeTurn`. `acc doctor` states this next to the Claude Code live-delivery
line, and `docs/TROUBLESHOOTING.md` explains it.

### 9. Documentation and skill

- Replace every Channels, shim, `~/.zshrc` and development-flag description in `README.md` and
  `docs/` with the inbox wake: `CAPABILITIES.md`, `CLI.md`, `CONFIGURATION.md`,
  `GETTING_STARTED.md`, `HOW_IT_WORKS.md`, `ARCHITECTURE.md`, `TROUBLESHOOTING.md`,
  `UPGRADING.md`, `ADAPTER_AUTHORING.md` (`offerKind`), `PROTOCOL.md` (the `woken` outcome) and
  the single-line mentions.
- `packages/adapter-claude-code/COMPATIBILITY.md` gets an "Inbox socket capture" section; the
  Channel sections stay as history under a heading that says the path was removed.
- The Claude skill stops saying "use this session's ACC MCP tools": the plugin ships none.

## Testing

- Adapter: bind, refresh, offer and retire against a fake registry and a real Unix socket in a
  temporary directory. Refusals: no env socket, registry missing, `sessionId` mismatch, socket
  path mismatch, a symbolic link, foreign permission bits. The written frame is exactly one line,
  carries no peer byte, and the connection sends no auth line.
- Router: an `offerKind: "wake"` adapter returns `woken`, leaves the receipt `queued` and records
  no event; a failed wake records `offer_failed`; a `message` adapter is unchanged.
- SDK: `offerKind` accepts only `message` and `wake`.
- Hook runner: a queued message whose wake succeeded is projected with its body on the next
  `beforeTurn` and committed as `offered` via `next-turn`.
- Installer: a recorded `claude` shell bootstrap is retired by install and by update, including
  the retained-activation branch; stale launchers and the old plugin cache copy are removed.
- Packed acceptance: install, update from a 0.7.1 layout that has the shim, and uninstall leave no
  shim, no `~/.zshrc` block, no `acc-channel` entry and no Channel launcher.
- Compatibility: a store written by this version validates under the 0.7.1 schema.
