# Capabilities

Use this page to set expectations after installation. Integration means ACC can introduce
peer awareness and coordination instructions; it does not guarantee what a model will do
with them. Delivery also varies independently from awareness. The durable inbox works for
every participant, supported exact versions may add next-turn delivery, and only the
experimental Claude Code channel can deliver while a session is idle.

Capability honesty separates four questions that are easy to collapse:

1. **Certified support** — did this exact client version and platform pass a shipped
   real-client fixture?
2. **Current reachability** — does one current session generation expose a live binding
   whose lease is valid now?
3. **Recipient policy** — did that recipient opt into spending a turn for this message
   kind?
4. **Fallback** — what durable path remains when any earlier answer is no?

A source method or vendor documentation is not certification. Unknown versions and
platforms degrade to false. No weaker session inherits a stronger peer's capability.

Run `acc doctor` in the project when observed behavior differs from this page. It reports
the installed client version, platform, effective capability, and fallback instead of
assuming that a newer or differently packaged client behaves like a captured one.

## Certified support

Passing evidence currently ships for these exact versions on `darwin-arm64`:

| Capability | Codex 0.147.0 | Claude Code 2.1.233 | Gemini CLI 0.57.0 | Grok 1.0.13 | Kimi 0.36.1 |
|---|---:|---:|---:|---:|---:|
| `lifecycle.sessionStart` | yes | yes | yes | no | yes |
| `lifecycle.sessionEnd` | yes | yes | yes | no | no |
| `lifecycle.heartbeat` | no | no | no | no | yes |
| `context.beforeTurnInjection` | yes | yes | yes | no | yes |
| `guards.beforeWrite` | yes | yes | yes | no | yes |
| `guards.beforeShell` | no | yes | yes | no | yes |
| `delivery.nextTurn` | yes | yes | yes | no | yes |
| `delivery.livePush` | no | no | no | no | no |
| `delivery.replyRoute` | no | no | no | no | no |

Every other capability in the closed shape defaults to false, including session resume,
child sessions, startup or safe-point injection, and before-read guards.

The `delivery.livePush` and `delivery.replyRoute` row is `no` for the exact hook versions
this matrix is keyed to. Native live delivery is captured on a newer client - Claude Code
2.1.258, livePush and replyRoute, confirmed again on 2.1.260 through the installed package -
and is admitted through the native delivery contract rather than exact-version
certification: it is off until a per-client opt-in, experimental, and never turns on for a
client below the captured minimum. Codex's queue capture passed and the capability was
withdrawn; the row below says why.

The limitations belong next to the adapters they affect:

| Adapter | Exact limitation and evidence |
|---|---|
| Codex | 0.147.0 next-turn stdout arrives as unwrapped developer-role context and requires plugin trust. A 0.152.1 capture proved the App Server queue transport, but the release capture then measured that native delivery there requires `codex --remote unix://`, and in that mode the session runs inside the daemon: both the hook payload and the App Server's own thread record report the daemon's directory instead of the session's, so ACC cannot tell which workspace the session is in. Nothing ACC can reach carries the real one, and placing a session in the wrong workspace is worse than not placing it, so `delivery.livePush` is **not** claimed - the probe and the handshake both refuse with `workspace_identity_unavailable`. `replyRoute` stays false. |
| Claude Code | 2.1.233 next-turn delivery waits for the next user prompt. A 2.1.258 Channel capture proved idle offer, busy queue-after-turn, explicit reply, duplicate suppression, and durable fallback, so `delivery.livePush` and `delivery.replyRoute` are live capabilities behind the native contract (experimental, off until opted in; Claude's development-channel warning is vendor-owned and visible). |
| Gemini CLI | Only 0.57.0 has package-shipped next-turn certification. Its TUI has no captured external wake or queue interface and `--acp` changes launch ownership, so native delivery is fallback-only; live push and reply routing remain false. |
| Grok | Documentation-shaped payloads do not count as real captures. The public leader surface exposed no proven addressed injection into an ordinary TUI session, so native delivery is `awaiting_compatibility_capture`; all capabilities remain false. |
| Kimi Code | 0.36.1 has next-turn and guard evidence, plus a 60-second heartbeat. Its server/queue APIs do not prove a transparent binding to an independently opened session, so native delivery is fallback-only. |
| Generic MCP | Tool polling is not next-turn injection, live push, or a native reply route. It has no write guard or client-lifecycle evidence. |

`certification.json` beside each adapter is machine-readable. `COMPATIBILITY.md` records the
captured client behavior, including what could not be observed.

## Current reachability

Certification is static evidence; reachability is runtime state. A live-capable adapter
would publish a generation-bound binding with `availableModes`, `clientVersion`,
`livePolicy`, and `leaseUntil`. `acc status --json` reports these as `deliveryBindings`
with a computed `reachable` boolean while keeping the opaque endpoint private.

The router requires exactly one current eligible generation. No binding, an expired lease,
several live sessions for one participant, a busy target, or a version that does not match
passing evidence all stay on durable fallback.

The lease is extended by whoever serves the endpoint, because only that process knows it is
still alive. A client that publishes no heartbeat - Claude Code among them - would otherwise
let the lease run out under an idle session, which is exactly when live delivery is worth
having. Giving a binding up is a separate, final fact rather than an expired lease, so a
channel that has not yet noticed cannot extend something the session already retired.

Current shipped reality: Claude Code on darwin-arm64 has a passing experimental `livePush`
capture behind the native delivery contract, off until a per-client opt-in. Codex is
next-turn and inbox only: its queue transport works, but the mode that makes a session
reachable is the mode that hides which workspace it is in. Every other client is next-turn or
inbox only. Gemini CLI and Kimi Code are next-turn only at their exact captured versions;
Grok and MCP poll inbox. On Linux, the shipped captures above do not establish next-turn or
live delivery, so the honest expectation is the durable inbox.

## Recipient policy

Native live delivery may start a model turn and spend tokens, so the recipient owns the
policy:

| Policy | Meaning |
|---|---|
| `off` | normal next-turn and inbox only |
| `actionable` | questions, requests, answers, decisions, and addressed handoffs may use live push; notes wait for the next turn |
| `all` | every addressed message kind may use live push |

The default is `off`. `acc install --delivery actionable|all` is an explicit request, not
a force switch. The installer applies it only when the detected exact client has certified
live push; otherwise effective policy remains off and the fallback diagnostic is printed.
Room messages are never live-push candidates.

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
