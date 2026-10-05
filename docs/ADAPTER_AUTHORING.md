# Writing an adapter

Use this page to add one client without leaking vendor behavior into core. Start with the
[identity contract](PROTOCOL.md#identity), then compare the shipped evidence under
[certified support](CAPABILITIES.md#certified-support). The [documentation map](index.md)
links the surrounding concepts and runtime architecture.

```mermaid
graph LR
  H[client hook] --> R[acc-hook runtime]
  R -->|normalizeHook| E[normalised event]
  E --> CO[core: attach, claims, sync]
  CO -->|denyOutcome / injectOutcome| R
  R --> H
```

## Define the manifest

```js
export function createExampleAdapter() {
  return defineAdapter({
    id: "example",                    // portable id
    displayName: "Example CLI",
    client: { command: "example", certificationName: "example-cli",
      versionArgs: ["--version"] },
    certification,                    // imported package-local certification.json
    capabilities: { delivery: { nextTurn: true } },

    detect, install, uninstall, doctor,
    planInstall,                      // what install would write
    preflightUninstall,               // optional read-only removal validation
    inboundSockets,                   // optional: socket paths a live sender connects to
    normalizeHook,                    // client payload -> normalised event
    renderContext,                    // SyncResult -> text
    renderContextResult,              // text + ids of complete rendered groups
    denyOutcome, injectOutcome,       // how this client is answered
  });
}
```

`preflightUninstall(context)` is optional and read-only. Throw to refuse unsafe
removal before the installer deactivates native integration or deletes recorded
artifacts. `uninstall` should retain its own validation for direct adapter callers;
recorded artifact fingerprint checks still determine the `keep` paths it receives.

`injectToolOwnerOutcome({ owner, tool })` is an optional identity-only hook callback.
The runner calls it after an allowed `beforeTool` handler only when that hook's
binding still names an open session with the same generation in this workspace.
Return `null` for an unsupported tool, or `{ stdout, stderr? }` using the client's
documented context envelope. The runner preserves the guard decision and the
owner line's byte budget. The callback receives no peer bodies or raw tool input;
it cannot create a session or advance receipts. Grok uses it to supply CLI owner
arguments after a terminal result. This does not certify general context or peer
delivery, and a tool such as `finish` can close the owner before the line arrives.

`continueTurnOutcome({ reason, payload })` is optional. A client whose end-of-turn hook can
hold a turn open implements it, and the runner's `turnEnd` handler calls it with the projected
peer context when - and only when - a peer body no invocation has shown yet is waiting. It
returns `{ stdout, stderr?, exitCode? }` in the client's own continuation shape, and prints
nothing to let the turn end. `payload` is the raw hook payload handed back unread, so the
adapter can apply its own ceiling from a counter the client supplies; nothing in core reads it.
An empty `stdout` records no offer, so the body stays queued for the next invocation. A
continuation costs the operator a model invocation, which is why an owner header or an
attention count is never a reason to call it. Antigravity CLI uses it for `Stop`, bounded to
one continuation per turn by the client's own `executionNum`.

`renderContextResult` is required wherever an adapter renders peer messages. It returns
`{ text, offeredMessageIds, includedAttentionIds }`, and the [receipt
lifecycle](PROTOCOL.md#receipt-lifecycle) advances only from those ids — never by searching
`text` for one, because peer text is untrusted and can imitate another message's header.
`projectContextResult()` implements this contract; `projectContext()` remains the text-only
convenience API for adapters that don't need it. An adapter with only the older
`renderContext()` gets pending bodies withheld and a visible `acc inbox` degradation warning
instead: repeating an untracked body every turn would be quieter in code and dishonest about
what was actually delivered.

The hook also supplies `reminderMessageIds`, derived from this participant's `offered` or
`retrieved` receipts with unresolved obligations. The standard projector combines those
reply/acknowledgement attention items into counts after new bodies. A missing body alone
is not evidence for compaction. Counts add no ids to `offeredMessageIds` or
`includedAttentionIds`; complete inbox and status results remain available.

`client.command` does double duty. `detect.mjs` uses it as the version-probe binary, and
presence liveness separately walks the hook's process ancestry for the first ancestor whose
executable basename matches it, to learn the client's own pid. A client shipped as a node
script, such as Gemini CLI, runs as `node`; for a `node` ancestor the walk also matches the
script it runs: the first argument after any interpreter options, by basename, with a
`.js`, `.mjs` or `.cjs` extension ignored. A word right after an option written without `=`
may be that option's value (`--require ./preload.cjs`), so it is also tried and the script
after it still counts. Declare the name the client actually runs as. A
command that matches neither resolves nothing, and the failure is silent: the session gets
`pid: null`, falls back to reading presence by age alone, and is not pinned to its
generation, with nothing telling you why.

Some vendors ship a second product that runs the same hooks: Antigravity 2.0, the desktop
app, runs `~/.gemini/config/hooks.json` under its own language server, with no `agy`, on a
version line of its own. Declare such a product as a variant and recognise its process:

```js
client: { command: "agy", certificationName: "antigravity-cli", versionArgs: ["--version"],
  variants: [{ certificationName: "antigravity-desktop", displayName: "Antigravity" }] },
identifyClientProcess: entry => /* null, or { certificationName, version } */,
clientVersionOf: async ({ pid, entry, env }) => /* the running client's version, or null */,
```

- `identifyClientProcess(entry)` is called with each ancestor `{ comm, args }` before the
  `client.command` match. It is synchronous and reads only the entry it is given; a throw is a
  "no". A `certificationName` that names no declared variant is ignored, with its version.
- Evidence may name a declared variant. A variant is judged only by its own evidence: its
  versions count on its own line, so the primary client's captures never stand in for it.
  Declaring a capability `true` still needs passing evidence of the primary client.
- The session's version is, in order: the version `identifyClientProcess` returned, then
  `clientVersionOf()`, then the client's own executable when `ps` names it by absolute path,
  then `client.command` on `PATH`. The `PATH` probe alone named the wrong build for a
  Claude.app session (its own claude, 2.1.286, against 2.1.289 on `PATH`) and for every
  Claude Code session that outlived an in-place update; Claude Code's adapter therefore reads
  the version from the session record Claude Code keeps for that pid.

## Declare only proven capabilities

Fourteen booleans in four groups, declared in the manifest's `capabilities` object:

| Group | Entries |
|---|---|
| `lifecycle` | `sessionStart` `sessionResume` `sessionEnd` `heartbeat` `childSessions` |
| `context` | `startupInjection` `beforeTurnInjection` `safePointInjection` |
| `guards` | `beforeRead` `beforeWrite` `beforeShell` |
| `delivery` | `nextTurn` `livePush` `replyRoute` |

**False by default. `true` requires a backing method *and* an observed capture.**
`defineAdapter` enforces the method — declaring `guards.beforeWrite: true` without
`guardWrite()` is a usage error at construction. It also requires a passing entry in the
validated `certification.json`; method existence is never evidence. What each shipped
client was actually observed doing against this list is under
[certified support](CAPABILITIES.md#certified-support).

`lifecycle.heartbeat` is deliberately not a flavour of `delivery.nextTurn`. Next-turn
delivery happens only when the client reaches a normal turn boundary; heartbeat fires on a
timer even while the session is idle.

### Certification evidence

Every adapter ships `certification.json` and every referenced capture under `fixtures/`.
Each evidence entry contains `client`, exact `version`, exact `platform`, `observedAt`,
`capability`, package-relative `fixture`, `idleBehavior`, `busyBehavior`,
`authorityLevel`, `limitations`, and `result` (`pass` or `fail`). A copied documentation
example is not a capture. Failed experiments stay in the manifest as `fail`; they explain
the false value and can never enable it.

`effectiveCapabilities(adapter, { clientVersion, platform })` returns the full boolean
shape for the installed client, resolving each capability independently from the evidence
that client can reach:

1. Take the rows for that capability, and keep those whose version is at or below the
   client's. A prerelease is ordered by its release triple, so `1.3.0-rc.1` is judged as
   `1.3.0`, and a version that cannot be read reaches every row.
2. Among those, prefer the rows that name this platform; with none, use them all. A loss
   recorded for one platform at 1.3.0 says nothing about that platform at 1.2.3, where
   another platform's passing capture is the only evidence in reach.
3. The highest version left decides. The capability is on when every row at that version
   passes, so a recorded loss wins a tie between platforms.

A client older than every row gets nothing, and so does a capability whose deciding row
records a failure. `capabilityEvidence(adapter, facts, capability)` returns that verdict
with its reason - `undeclared`, `unobserved`, `older-than-evidence` or `recorded-failure` -
and the version that decided, so a refusal can name the evidence rather than the client.

Recording a regression is an ordinary capture with `result: "fail"` at the version where
the loss was observed; it applies forward until a later row passes again.

The backing methods for delivery are `renderContextResult()` for `nextTurn`,
`offerMessage()` for `livePush`, and `routeReply()` for `replyRoute`.

### Native delivery contract

An adapter that can push a message into a running session declares `nativeDelivery` next
to its capabilities:

```js
nativeDelivery: {
  minimum: "2.1.282",
  anchors: [{ version: "2.1.282", protocolContract: "claude-code-inbox-socket-v1" }],
  knownBad: [],
  activationKinds: ["native-service"],
  offerKind: "wake",
}
```

The rules `defineAdapter` enforces, and the ones the runtime applies:

- The minimum is the **first passing capture**, never a guessed first vendor release. Every
  anchor must have passing `delivery.livePush` evidence for the same client and version, and
  the minimum must itself be an anchor. The platform an evidence row names is where the
  capture was taken; it is provenance, and the anchor names no platform.
- An anchor may name a declared variant, `{ version, protocolContract, client }`, for a
  delivery protocol only that product speaks. Each protocol's floor is its own first passing
  capture: a handshake or probe is judged against the floor of the protocol it reports, and
  one protocol cannot be anchored for two products. `minimum` stays the primary client's
  first capture, and `knownBad` names the primary client's versions.
- There is intentionally **no maximum version** and **no platform**. A newer release is
  admitted, on every platform, only when a current read-only feature probe
  (`probeNativeDelivery()`) and a per-session handshake (`bindNativeSession()`) both report
  the anchored `protocolContract`; `evaluateNativeEligibility()` and
  `validateNativeHandshake()` are those two checks.
- A prerelease is judged by its release triple, as hook capabilities are: `2.2.0-beta.1` is
  `2.2.0` against the minimum and `knownBad`. `knownBad` names exact versions or inclusive
  intervals. A version that cannot be read at all is `version_unavailable`.
- Certification evidence still governs every non-native capability;
  `effectiveCapabilities()` is unchanged. The native rule is used for live delivery alone.

What may refuse live delivery is exactly three things:

- the machine's own probe or per-session handshake failing;
- a client older than the first passing capture;
- a regression recorded in `knownBad`.

Nothing else: not the platform, not a prerelease suffix, not where the evidence was taken. A
transport that is technically different on some platform is the probe's fact to report, as
`native_delivery_unsupported`, never a gap in the captures. The 0.8.0 shape,
`minimumByPlatform` with a platform on each anchor, is refused by name; the design record is
`docs/design/2026-09-26-native-delivery-across-platforms.md` in the repository.
- Native methods return closed facts (`validateNativeActivationPlan()` closes the
  activation plan) and never put vendor data - endpoints, sockets, raw errors - into core.
  A refused handshake may add `launchOption`: the bare command-line option, such as
  `--search`, that made the client refuse. Doctor and the sender name it; a value, a vendor
  string or anything but an option token is rejected.

`nativeDelivery.policySource` accepts only `"installation-record"`, which is also the
default. Hooks and senders read the current recorded recipient consent, independently of
the vendor process environment. Installation records the requested policy even when
current activation is unavailable. An absent or invalid record means `off`. A previously
published binding cannot override it.

`nativeDelivery.offerKind` says what an accepted offer puts in front of the model. It is
`"message"` (the default) or `"wake"`:

- `"message"` carries the body. The router records the receipt as `offered` with the
  transport name and returns the outcome `offered`.
- `"wake"` carries only a notice that makes the client run a turn. The router records no
  offer and returns the outcome `woken`. The receipt stays `queued`. The next-turn hook
  records `offered` via `next-turn` after its output carried the body. Use `"wake"` only
  where the turn that the wake starts runs the client's next-turn hook, as Claude Code's
  `UserPromptSubmit` does. When the client takes the wake but holds it for its user's
  approval, return `pendingApproval: true` with the acceptance; the outcome carries it so
  the sender is told the truth.

A failed offer of either kind is recorded as a failed offer and leaves the receipt queued.

`nativeDelivery.activationKinds` names the mechanisms the adapter may plan:
`"native-config"` or `"native-service"`. A `native-service` mechanism with
`preExisting: true` and no commands describes a service that the client itself runs, such
as the Claude Code inbox. A `shell-bootstrap` mechanism can no longer be planned. Install
records of one stay readable, so that `acc install` and `acc update` can retire it.

The optional `refreshNativeSession()` method may revalidate an expired lease before
an offer. It returns the same closed handshake shape as `bindNativeSession()` and
must preserve the exact endpoint and protocol identity. The router rechecks the
current session, generation, retirement, uniqueness and policy before publishing
the refreshed lease. Refresh is not a heartbeat and cannot extend presence beyond
its own expiry. Optional `retireNativeSession()` cleans adapter-owned endpoint state
after confirmed core retirement; it must remain bounded and fail open for hooks.

An adapter whose `offerMessage()` connects to a Unix socket in the recipient's session
declares where those sockets live with the optional `inboundSockets(context)`. It returns
absolute paths, directories or sockets, derived from `context.env`, `context.platform` and
the client homes in the context. It runs synchronously, once per install, doctor or refresh
command, and must never throw. It may read the adapter's own records under
`context.stateRoot` when a session can bind outside what the environment implies. Claude Code
reads its endpoint records there, and keeps each read bounded. The installer
composes every known adapter's declaration into `context.receiverSockets`. An adapter whose
client sandboxes the sender's shell allows exactly that list, and reports its outgoing
permissions configured only while every entry is allowed. It never names another vendor's
paths itself. Codex does this in its permission profile. Declare a new receiving transport
here, or every Codex sender gets `transport_permission_denied` against it.

A package-shipped passing Codex installed-hook capture additionally references its
complete real product matrix through the selected provenance record's
`productEvidence: { fixture, sha256 }`. Package verification checks the actual file,
raw digest and client/version/platform/package identity. A transport-only capture
cannot certify the installed product route. `historicalFixtures` may retain hashed
earlier failures without duplicating a certification tuple.

## Choose the integration depth

| Tier | You register | You get | You do not get |
|---|---|---|---|
| 0 | nothing — humans run `acc` | durable messages, status, claims | anything automatic |
| 1 | the MCP server | attach on first call, read, claim, message | guards, session end |
| 2 | hooks + skill | only the lifecycle, context, guard, and next-turn behaviors separately captured for this client | uncaptured hook behaviors |
| 3 | + native delivery surface | only captured live-push and reply-route modes | safe-point injection or child sessions unless separately captured |

Installed hook wiring may reach tier 2, but each effective hook capability still
requires exact client/version/platform evidence. Tier 3 has separate native
contracts: the Claude Code inbox wake from 2.1.282 and Codex LocalDaemon from 0.152.1 on
macOS arm64, with current probes and exact session handshakes. Codex's earlier
remote-wrapper failure remains historical evidence. Ordinary launch now preserves
workspace identity; the full installed product matrix, including negative controls
and fallback, backs its native claim.

## Normalize hook input

Whitelist, never a filter. Every client hands hooks the prompt, the transcript path, or the
tool output; none of it may survive.

```js
return normalizedEvent({
  kind, sessionId, cwd, model, parentSessionId, tool,
  targets,   // paths this call would WRITE. For a shell call, pass the command to
             // shellWriteTargets() — it reads write positions only, never reads.
  permissionMode, // the client's own name for the session's permission mode, or null
  endReason,      // on sessionEnd, the client's own word for why, or null
});
```

`permissionMode` and `endReason` are optional and default to `null`. Pass `permissionMode`
when the client's hook reports one: a native binding reads it to tell a sender whether the
client will hold a wake for approval. Claude Code reports it on most hooks but not on
`SessionStart`. Pass `endReason` on `sessionEnd` when the client says why, as Claude Code's
`reason` does (`"clear"` after `/clear`). ACC keeps it in the closed session record's
`extensions`, and a sender is told that the conversation was cleared.

Refuse an unrecognised payload. Inventing a session attaches the wrong one, or a new one
every hook, and looks like it is working.

`normalizeHook(payload, { args })` also receives the arguments the client's hook command
carried after the adapter id. Most clients name the event inside the payload and ignore this.
Antigravity CLI does not send one at all, and its `PreInvocation` and `PostInvocation` hand
over byte-identical envelopes - so for that client the registered command's own argument is
the only thing that knows which hook ran, and its install writes the event name into each
command. `args` is always an array; an adapter that does not need it may take one parameter.

## Measure response contracts

Measure them. Every client differs, and a wrong shape fails **silently**:

| | deny | inject |
|---|---|---|
| Codex | exit 2 + stderr | plain stdout (`developer` message) |
| Claude Code | `hookSpecificOutput.permissionDecision` | same envelope |
| Gemini CLI | `{"decision":"block"}` | `hookSpecificOutput` envelope |
| Antigravity CLI | no tool event loads, so a deny is unreachable | `{"injectSteps":[{"ephemeralMessage"}]}` from `PreInvocation` |
| Grok | `{"decision":"deny","reason"}` (documented; deny not yet captured) | UserPromptSubmit stdout discarded; own identity only via PreToolUse after a terminal result, observed on 1.0.24 |
| Kimi Code | `hookSpecificOutput.permissionDecision` | plain stdout |

`denyOutcome(reason)` returns `{ stdout, stderr, exitCode }`, so the runtime never has to
know which client it is talking to. This table is only the shape each shipped adapter
actually uses; the full experimental grid — every candidate shape tried against every
client, including which ones are silently ignored — is recorded in each adapter's
`COMPATIBILITY.md` and certification fixtures. The cross-client summary is under
[guard limitations](CAPABILITIES.md#guard-limitations).

## Preserve install ownership

```mermaid
graph TB
  P[planInstall] -->|artifacts| K{kind}
  K -->|tree| T[a directory ACC creates<br/>removable if unchanged]
  K -->|merge| M[a file the user owns<br/>never deleted]
```

Rules that are not negotiable:

- idempotent — installing twice equals installing once;
- reversible — uninstall restores the user's file byte for byte;
- absolute command paths — a hook's environment carries no PATH;
- honour `keep`: uninstall receives paths the user has since edited.

`planInstall` must use the same path helpers as `install`. A conformance test compares
them, because a plan that drifts makes `--dry-run` a decoration.

## Run conformance

```bash
node --test tests/conformance/*.test.mjs
node --test tests/process/hook-wiring.test.mjs
```

The second one *executes* what your install wrote. Three adapters once shipped a hook
command that did not exist anywhere; every test was green.

## Record the evidence

One `COMPATIBILITY.md` per adapter: client version, event names, payload fields, the deny
matrix, and what you could **not** observe. The next person's alternative is guessing.
