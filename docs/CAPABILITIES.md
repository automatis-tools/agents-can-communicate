# Capabilities

Use this page to set expectations after installation. Integration means ACC can introduce
peer awareness and coordination instructions; it does not guarantee what a model will do
with them. Delivery also varies independently from awareness. The durable inbox works for
every participant, supported exact versions may add next-turn delivery, and the
experimental Codex LocalDaemon and Claude Code Channel paths can deliver while a session is idle.

Capability honesty separates four questions that are easy to collapse:

1. **Certified support** — did this exact client version and platform pass a shipped
   real-client fixture?
2. **Current reachability** — does one current session generation expose a live binding
   whose lease is valid now?
3. **Recipient policy** — did that recipient opt into spending a turn for this message
   kind?
4. **Fallback** — what durable path remains when any earlier answer is no?

A source method or vendor documentation is not certification. Uncaptured hook versions and
unsupported platforms degrade to false. Native minimum-based eligibility is separate. No weaker session inherits a stronger peer's capability.

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

The native rows remain `no` for the older exact hook versions in this matrix.
Separate installed-client captures establish Codex `livePush` on 0.152.1 and
0.153.4, and Claude Code `livePush` plus `replyRoute` on 2.1.258 and 2.1.260.
Native eligibility uses the captured platform minimum, a current feature probe,
and an exact per-session handshake. It is experimental and requires recipient
opt-in. Codex replies through `acc reply`; its native `replyRoute` remains false.

The limitations belong next to the adapters they affect:

| Adapter | Exact limitation and evidence |
|---|---|
| Codex | Exact 0.147.0 next-turn context requires plugin trust. The observed stock 0.153.4 upgrade from ACC 0.3.1 to 0.4 required fresh review of five modified hook definitions; a subsequent restart retained all five active (activation evidence, not new event certification). LocalDaemon native delivery was captured through the installed package on 0.152.1 and 0.153.4, darwin-arm64; minimum 0.152.1, recorded opt-in, current feature probe and exact thread/cwd/process/version/protocol checks are required. Ordinary launch preserves the receiver workspace without ACC arguments or daemon ownership. Embedded or unreachable sessions keep their inbox. Native `replyRoute` remains false. |
| Claude Code | 2.1.233 next-turn delivery waits for the next user prompt. A 2.1.258 Channel capture proved idle offer, busy queue-after-turn, explicit reply, duplicate suppression, and durable fallback, so `delivery.livePush` and `delivery.replyRoute` are live capabilities behind the native contract (experimental, off until opted in; Claude's development-channel warning is vendor-owned and visible). |
| Gemini CLI | Only 0.57.0 has package-shipped next-turn certification. Its TUI has no captured external wake or queue interface and `--acp` changes launch ownership, so native delivery is fallback-only; live push and reply routing remain false. |
| Grok | Documentation-shaped payloads do not count as real captures. The public leader surface exposed no proven addressed injection into an ordinary TUI session, so native delivery is `awaiting_compatibility_capture`; all capabilities remain false. |
| Kimi Code | 0.36.1 has next-turn and guard evidence, plus a 60-second heartbeat. Its server/queue APIs do not prove a transparent binding to an independently opened session, so native delivery is fallback-only. |
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
failure leaves the message queued. Busy behavior belongs to the transport: Claude's Channel can accept a
message while the target is busy and queue it until the current turn finishes; an adapter
that instead refuses with `recipient_busy` leaves the message on the durable path.

An endpoint may renew its lease, or an adapter may revalidate that exact endpoint on
demand without a client heartbeat. Retirement is final: neither route may revive a
retired binding, a closed session or an old generation. Delivery lease refresh does
not renew participant presence.

On darwin-arm64, Codex LocalDaemon and Claude Code Channel have captured
experimental live delivery. Other adapters retain their separately certified
next-turn paths or inbox polling. Linux and other uncaptured platforms retain
the durable inbox; these captures establish no new hook capabilities there.

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
Current activation remains off when the platform, captured minimum or feature probe
does not qualify; that temporary failure does not erase the requested policy. Each
session must pass its own generation-bound handshake. An adapter using the installation
record rereads consent at hooks and before offers, so a long-running vendor process
cannot retain permission through an old environment value or binding snapshot.

For an adapter using recorded consent, `--delivery off` and uninstall prevent new
native offers. They cannot withdraw a submission already accepted by the vendor queue. Ordinary hook capabilities still
require exact-version certification. Room messages are never live-push candidates.

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
