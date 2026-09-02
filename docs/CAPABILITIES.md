# Capabilities

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

## Certified support

Passing evidence currently ships for these exact versions on `darwin-arm64`:

| Capability | Codex 0.147.0 | Claude Code 2.1.233 | Gemini CLI 0.37.0 | Grok 1.0.13 | Kimi 0.36.1 |
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

The limitations belong next to the adapters they affect:

| Adapter | Exact limitation and evidence |
|---|---|
| Codex | 0.147.0 next-turn stdout arrives as unwrapped developer-role context and requires plugin trust. The separate 0.152.0 native capture found no daemon control socket; ACC did not start one, so live push and reply routing remain false. |
| Claude Code | 2.1.233 next-turn delivery waits for the next user prompt. The 2.1.252 channel capture stopped at the development-channel warning before the ACC MCP child started; native delivery branches are unobserved and false. |
| Gemini CLI | Only 0.37.0 has package-shipped next-turn certification. Write and shell tools depend on approval mode; other versions and platforms retain inbox access but no effective delivery capability. |
| Grok | Documentation-shaped payloads do not count as real captures. UserPromptSubmit context was observed discarded, and no deny was captured stopping a real write; all capabilities remain false. |
| Kimi Code | 0.36.1 has next-turn and guard evidence, plus a 60-second heartbeat. Prompt-mode `SessionEnd` never fired, and its next-turn path does not interrupt an active turn. |
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

Current shipped reality: no adapter publishes a native live binding, and no adapter has
passing `livePush` certification. Codex and Claude Code are next-turn or inbox only;
Gemini CLI and Kimi Code are next-turn only at their exact captured versions; Grok and MCP
poll inbox.

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
| exact-certified Gemini CLI 0.37.0 | complete peer body at the next normal turn; `acc inbox` remains recoverable |
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
