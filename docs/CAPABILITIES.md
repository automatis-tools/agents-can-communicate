# Capabilities

Use this page to set expectations after installation. Integration means ACC can introduce
peer awareness and coordination instructions; it does not guarantee what a model will do
with them. Delivery also varies independently from awareness. The durable inbox works for
every participant, a client at or after a captured version may add next-turn delivery, and the
experimental Codex LocalDaemon, Claude Code inbox wake and Antigravity relay and desktop paths
can deliver while a session is idle.

Capability honesty separates four questions that are easy to collapse:

1. **Certified support** — does the evidence this client can reach show the capability
   passing in a shipped real-client fixture?
2. **Current reachability** — does one current session generation expose a live binding
   whose lease is valid now?
3. **Recipient policy** — did that recipient opt into spending a turn for this message
   kind?
4. **Fallback** — what durable path remains when any earlier answer is no?

A source method or vendor documentation is not certification. A capture applies forward: from
the version that recorded it until a later capture changes that capability, and to every
platform until one of them records something of its own. A client older than every capture
degrades to false, and so does a capability a capture recorded as failing. Native live
delivery reads its captured minimum the same way: on every platform, with a prerelease judged
by its release triple. No weaker session inherits a stronger peer's capability.

Run `acc doctor` in the project when observed behavior differs from this page. It reports
the installed client version, platform, effective capability, and fallback instead of
assuming that a newer or differently packaged client behaves like a captured one.

## Certified support

Each column names the version that recorded the capture, on `darwin-arm64`. Every later
version of that client reads it, on every platform, until a capture of its own says
otherwise. A client older than the version named here is unproven and gets nothing.

| Capability | Antigravity 1.2.7 | Codex 0.147.0 | Claude Code 2.1.233 | Gemini CLI 0.57.0 | Grok 1.0.13 | Kimi 0.36.1 |
|---|---:|---:|---:|---:|---:|---:|
| `lifecycle.sessionStart` | yes | yes | yes | yes | no | yes |
| `lifecycle.sessionEnd` | no | yes | yes | yes | no | no |
| `lifecycle.heartbeat` | no | no | no | no | no | yes |
| `context.beforeTurnInjection` | yes | yes | yes | yes | no | yes |
| `guards.beforeWrite` | no | yes | yes | yes | no | yes |
| `guards.beforeShell` | no | no | yes | yes | no | yes |
| `delivery.nextTurn` | yes | yes | yes | yes | no | yes |
| `delivery.livePush` | yes | no | no | no | no | no |
| `delivery.replyRoute` | no | no | no | no | no | no |

Every other capability in the closed shape defaults to false, including session resume,
child sessions, startup or safe-point injection, and before-read guards.

The native rows are `no` at the hook versions this matrix names.
Separate installed-client captures establish Codex `livePush` on 0.152.1 and
0.153.4, Claude Code `livePush` on 2.1.282 through the session inbox, and
Antigravity CLI `livePush` on 1.2.7 and later through a relay the agent starts in its own shell.
Native eligibility uses the captured minimum, a current feature probe, and an exact
per-session handshake. It is experimental and requires recipient opt-in.

What may refuse live delivery is exactly three things:

- the machine's own probe or per-session handshake failing;
- a client older than the first passing capture;
- a regression recorded in `knownBad`.

Nothing else: not the platform, not a prerelease suffix, not where the evidence was taken.
A platform whose transport is technically different is refused by the probe as a fact about
that transport. Codex, Claude Code and Antigravity CLI reply through `acc reply`. Their native
`replyRoute` remains false.

The limitations belong next to the adapters they affect:

| Adapter | Exact limitation and evidence |
|---|---|
| Antigravity CLI | 1.2.7 on darwin-arm64, captured in print mode, and every later release by the forward rule. Only `SessionStart`, `PreInvocation`, `PostInvocation` and `Stop` load; `SessionEnd`, `PreToolUse` and `PostToolUse` are accepted into the config file and silently dropped, so there is no tool guard and no session-end deregistration - a session goes offline by presence age or an explicit `acc finish`. Payloads carry no `hook_event_name`, so each registered command passes its own event name. The end-of-turn `Stop` continuation reaches the model and is a bounded nudge, not a gate: ACC continues a turn at most once and fails open, and the client caps consecutive continuations itself (vendor 1.1.9). `agy agentapi send-message` can wake an idle session - captured - but only with that session's language-server address and CSRF token, which exist in the agent's own shell and in no hook; reply routing is false. A peer message that arrives while the model writes its last answer is carried by the `Stop` continuation instead. A write that parses can register nothing, so install and doctor read `agy -p "/hooks"` back instead of trusting the file. Live push (1.2.7, darwin-arm64, TUI only, experimental, recorded opt-in) runs through a relay the agent starts once per conversation from its own shell - the only process holding the session endpoint - after ACC's context asks it to, up to three times while none is serving; install allows that command too, so the agent starts the relay without a prompt (1.2.16, 2026-10-04); on Windows, where install adds no rule, the operator approves it at the client's permission prompt. An idle session wakes; a busy one sees the message after its running answer, or at the next model invocation when the turn waits on a tool. Print mode and the first session in a folder trusted at that launch get no relay. The client asks before every shell command (1.2.12), so install adds the prefix rule `command(<wrapper>)` to the client's settings, except on Windows, to let the woken agent's ACC commands run without that prompt. A woken session answered with no prompt under that rule on 1.2.12 (2026-09-28); print mode with it has not been captured. On Windows the relay listens on a named pipe, `\\.\pipe\acc-relay-<32 hex>`, starts with `node`, and runs `agy.exe` itself, never a `.cmd`, since the message reaches agy as an argument. |
| Antigravity 2.0 (desktop app) | 2.19.1 on darwin-arm64, captured 2026-10-04. The app runs the same `~/.gemini/config/hooks.json` under its own language server, with no `agy`, so ACC identifies the session by that server and the version on its command line (`--override_ide_version`), and judges it by the desktop's own evidence, never by Antigravity CLI's version line. `SessionStart` and `PreInvocation` fire; a peer message reaches the model at the next model invocation. Live push (2.19.1, darwin-arm64, experimental, recorded opt-in) needs no relay and no command from the agent: ACC reads the endpoint from the language server's command line when it binds and when it delivers, keeps the token only in one `agentapi` child's environment, and pushes into the conversation through the server's own `agentapi`. A product capture passed all six cases: an idle conversation woke with no user input; a push during a long answer was shown after it, uninterrupted; the woken agent answered with `acc reply` without an approval prompt; a resent message reached the model once; with the app quit the message stayed queued; after a restart the conversation's next turn bound it again. The app runs no `SessionStart` for a conversation it reopens, so after a restart live delivery returns at that next turn. One language server serves every window and conversation, so a desktop participant goes offline when the app quits. The app runs the agent's commands in a sandbox where ACC's wrapper cannot run; the model then retries outside it, which the app allows by the grants in `~/.gemini/config/config.json`, and install adds ACC's rule there once the app has run. Installing the integration still needs Antigravity CLI, whose `agy -p "/hooks"` reads the registration back. |
| Codex | Next-turn context, captured on 0.147.0, requires plugin trust. The observed stock 0.153.4 upgrade from ACC 0.3.1 to 0.4 required fresh review of five modified hook definitions; a subsequent restart retained all five active (activation evidence, not new event certification). LocalDaemon native delivery was captured through the installed package on 0.152.1 and 0.153.4, darwin-arm64; minimum 0.152.1, recorded opt-in, current feature probe and exact thread/cwd/process/version/protocol checks are required. Ordinary launch preserves the receiver workspace without ACC arguments or daemon ownership. On macOS and Linux, install adds ACC's own Codex rules file, so the commands a participant runs need no approval and Codex's auto-review never judges a message to a local peer. On Windows, where Node cannot open the daemon's AF_UNIX socket, ACC speaks the same protocol over the stdio of `codex app-server proxy` (measured on 0.159.3); Codex starts its daemon only from a terminal that is not elevated. Embedded or unreachable sessions keep their inbox. The Codex app (inside ChatGPT.app, read on 26.928) runs every chat on a private app server over stdio rather than the shared daemon (openai/codex#41014); its chats run ACC's hooks, receive messages at their next turn, and are reported as `client_session_embedded`. Native `replyRoute` remains false. |
| Claude Code | 2.1.233 next-turn delivery waits for the next user prompt. From 2.1.282, captured on darwin-arm64 and applied on every platform, `delivery.livePush` is a live capability behind the native contract (experimental, off until opted in). ACC wakes the session through the inbox socket that Claude Code opens for every session, with one line of fixed ACC text and the message id. An idle session starts a turn. A busy session takes the wake between two tool calls. Each delivered wake fires `UserPromptSubmit`, so the next-turn hook shows the body and records the receipt `offered` via `next-turn`. The model answers with `acc reply`, so `delivery.replyRoute` stays false. A session in `bypassPermissions` mode holds each wake for approval unless `crossSessionInbound` is `accept`, and `refuse` drops wakes. Claude.app runs a local Code session on a Claude Code build of its own with the same `~/.claude`: such a session registers the same inbox (`entrypoint: claude-desktop`), and on 2.1.286 (2026-10-04) an idle one woke and answered with `acc reply` with no adapter change. Its Cloud, SSH and Cowork sessions run on another machine. ACC takes a session's version from the record Claude Code keeps for that process, because the `claude` on `PATH` can be another build. On native Windows the inbox is a named pipe, `\\.\pipe\LOCAL\cc-msg-<32 hex>`, that drops a frame without an auth line; ACC authenticates with the peer key Claude Code publishes beside the session record for other sessions of the same user, never the session's own token, so the recipient's inbound settings apply as on POSIX. Measured on 2.1.286; the real-clients CI job wakes an idle interactive Claude Code on Linux and on Windows. |
| Gemini CLI | Package-shipped next-turn certification starts at 0.57.0. Its TUI has no captured external wake or queue interface and `--acp` changes launch ownership, so native delivery is fallback-only; live push and reply routing remain false. |
| Grok | The Grok 1.0.24 installed-client check observed own CLI arguments after a terminal result, followed by owned work, message, and finish calls. This identity-only path does not certify peer-context injection. Documentation-shaped payloads do not count as real captures. The public leader surface exposed no proven addressed injection into an ordinary TUI session, so native delivery is `awaiting_compatibility_capture`; all capabilities remain false. |
| Kimi Code | Next-turn and guard evidence was captured on 0.36.1, plus a 60-second heartbeat. Its server/queue APIs do not prove a transparent binding to an independently opened session, so native delivery is fallback-only. |
| Generic MCP | As a receiver, tool polling is not next-turn injection, live push, or a native reply route. It has no write guard or client-lifecycle evidence. Outgoing messages may use an eligible recipient's opted-in native adapter. |

`certification.json` beside each adapter is machine-readable. `COMPATIBILITY.md` records the
captured client behavior, including what could not be observed.

## Current reachability

Certification is static evidence; reachability is runtime state. A live-capable adapter
would publish a generation-bound binding with `availableModes`, `clientVersion`,
`livePolicy`, and `leaseUntil`. `acc status --json` reports these as `deliveryBindings`
with a computed `reachable` boolean while keeping the opaque endpoint private.

The router requires exactly one current eligible generation. No binding, several live
sessions for one participant, and an adapter refusal keep delivery on the durable
fallback. An expired lease may be revalidated by an adapter's optional refresh method;
failure leaves the message queued. Busy behavior belongs to the transport. Codex accepts a
message while the target is busy and holds it until the current turn finishes. Claude Code
takes a wake between two tool calls of the running turn. An adapter that instead refuses
with `recipient_busy` leaves the message on the durable path.

An endpoint may renew its lease, or an adapter may revalidate that exact endpoint on
demand without a client heartbeat. Retirement is final: neither route may revive a
retired binding, a closed session or an old generation. Delivery lease refresh does
not renew participant presence.

Codex LocalDaemon, the Claude Code inbox wake and the Antigravity CLI relay have captured
experimental live delivery, on darwin-arm64. Those captures set the minimum that applies on
every platform; on a host they never named, the probe and the per-session handshake decide,
and a transport that does not answer keeps the durable inbox. Other adapters retain their
separately certified next-turn paths or inbox polling.

Codex's 120-second delivery lease can refresh on demand for the same live endpoint;
it does not extend the 24-hour participant presence limit. A TUI exit can leave its
daemon thread loaded and able to execute opted-in messages. Actual thread teardown,
including explicit archive, runs `SessionEnd` and retires the binding. Turning ACC
delivery off prevents new offers even while that thread remains loaded.

## Recipient policy

Native live delivery may start a model turn and spend tokens, so the recipient owns the
policy:

| Policy | Meaning |
|---|---|
| `off` | normal next-turn and inbox only |
| `actionable` | questions, requests, answers, decisions, and addressed handoffs may use live push; notes wait for the next turn |
| `all` | every addressed message kind may use live push |

The default is `off`. `acc install --delivery actionable|all` records recipient consent.
Current activation remains off when the captured minimum or the feature probe does not
qualify; that temporary failure does not erase the requested policy. Each
session must pass its own generation-bound handshake. Every adapter reads consent from the
installation record and rereads it at hooks and before offers, so a long-running vendor
process cannot retain permission through an old binding snapshot.

`--delivery off` and uninstall prevent new native offers. They cannot withdraw a submission
already accepted by the vendor queue. Ordinary hook capabilities still require exact-version
certification. Room messages are never live-push candidates.

## Fallback

| Participant | Durable behavior when acceleration is unavailable |
|---|---|
| exact-certified Codex 0.147.0 | complete peer body at the next normal turn; `acc inbox` remains recoverable |
| exact-certified Claude Code 2.1.233 | complete peer body at the next normal prompt; `acc inbox` remains recoverable |
| exact-certified Gemini CLI 0.57.0 | complete peer body at the next normal turn; `acc inbox` remains recoverable |
| exact-certified Kimi Code 0.36.1 | complete peer body at the next normal turn; `acc inbox` remains recoverable |
| Grok, generic MCP, unknown version, other platform | explicit `acc inbox` polling |

A send that committed durably succeeds even if a transport later fails. The delivery array
names the queued fallback and safe error code. There is no terminal failed receipt.

## Guard limitations

A guarded claim stops only paths the client exposes to a captured pre-tool hook. Codex's
write guard depends on the model offering `apply_patch`; recognised shell writes can be
matched, but a language runtime opening a file cannot. Gemini's edit tools depend on
approval mode. Grok has no certified guard. One live advisory session lowers workspace
protection to advisory because that is the strongest honest room-wide statement.

Hook response shapes are vendor-specific and not portable. An ignored deny response often
fails silently, which is why each true cell above needs its own fixture rather than a
shared documentation example.

Next: [Protocol](PROTOCOL.md) · [MCP](MCP.md) ·
[Adapter authoring](ADAPTER_AUTHORING.md)
