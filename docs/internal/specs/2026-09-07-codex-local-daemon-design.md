# Codex native delivery through an existing local daemon

Status: implementation design, not a capability certification. Prepared against
ACC `a059e56` (0.3.1) after independent live investigation on 2026-09-07 local
time / 2026-09-08 UTC. No implementation is included in this document change.

## Decision and evidence

Restore native delivery for an **individually verified, already loaded Codex
thread**, using the ordinary vendor command. ACC must not add `--remote`, `--cd`,
start a daemon, or create/resume a target thread to make delivery possible.

The original [issue](https://github.com/openai/codex/issues/42457) and
[reply](https://github.com/openai/codex/issues/42457#issuecomment-5573726075)
describe explicit remote startup. Independent live runs distinguish it from
ordinary LocalDaemon startup:

| Actual client, launched from B; daemon started from A | 0.152.1 | 0.153.4 |
| --- | --- | --- |
| Ordinary `codex` | Hooks, thread metadata and actual shell pwd = B; idle queue executed in B | Same |
| `codex --remote unix://` | Hooks, metadata and actual pwd = A | Same |
| Remote with absolute `--cd B` | Hooks, metadata and actual pwd = B; idle queue executed in B | Same |

Additional real observations:

- On 0.152.1, a queue submission made during a confirmed active shell command
  stayed pending until the first turn ended, then executed in B. Two earlier
  attempts without a valid busy interval were excluded from this conclusion.
- Adding `-c 'model_reasoning_effort="low"'` on 0.152.1 selected Embedded: hooks
  and actual pwd remained B, but the exact thread was absent from loaded/list.
- Remote relative `--cd relative` selected A/relative, not B/relative.
- Remote resume/fork of saved B threads retained B when launched from C.
- Ordinary `/cd C` on 0.153.4 created a new thread ID. The old B and new C IDs
  remained separately addressable; same-ID cwd drift was not demonstrated.
- Current ACC found a correctly located live 0.153.4 thread and still explicitly
  refused probe/bind with `workspace_identity_unavailable`.

The retained local report is `/private/tmp/acc-42457-live/REPORT.md`; its verifier
passed 62 assertions. Its negative control expecting remote pwd B failed on the
original symptom. That report uses minimal metadata hooks and direct queue calls,
**not installed ACC E2E**. This summary preserves its conclusions if temporary
artifacts disappear. It cannot serve as the new product certification.

The upstream distinction is visible in [mode selection](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/tui/src/lib.rs#L859-L930)
and [cwd request construction](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/tui/src/app_server_session.rs#L2009-L2020).

## Alternatives

1. Prefix remote plus absolute cwd: works in the measured simple case, but changes
   launch semantics, conflicts with an existing `--cd`, and does not transparently
   preserve config/profile, resume/fork, or relative-path behavior. Rejected.
2. Ordinary launch plus verified existing-thread delivery: selected. Embedded or
   unreachable sessions retain durable delivery. No vendor-launch wrapper needed.
3. Keep all Codex native delivery disabled: safe fallback if installed-package
   evidence fails, but no longer justified by a universal workspace limitation.

## Global constraints

- Node >=24, ESM, node:test; no new runtime dependencies.
- Runtime state stays outside repositories; Git remains optional.
- Core contains no vendor branches, adapter imports, Git, or child_process.
- No coordinator, background ACC service, transcript collection, or target-session launcher.
- Hooks fail open; a native-delivery failure leaves the durable message recorded.
- Codex launch arguments are unchanged; ACC never adds --remote or --cd.
- Proposed native minimum: 0.152.1 on darwin-arm64, conditional on fresh installed-package evidence.
- Run the complete real-client matrix on both 0.152.1 and 0.153.4; uncaptured platforms remain unsupported.
- Native replyRoute remains false; acc reply proves the product reply loop only.
- Next-turn certification remains exact-version; do not imply 0.147.0 evidence certifies newer hooks.
- Every new or corrected gate must fail under its named mutation before it is trusted.
- Do not push, merge, publish a release, or post a GitHub comment as part of this work.

## Installation consent and migration

The current `ACC_NATIVE_DELIVERY_POLICY` environment value is exported by an ACC
shell bootstrap. A pre-existing daemon does not inherit a later TUI's environment.
An empty wrapper or a hardcoded hook policy would therefore be insufficient.

Use the existing machine installation record (`acc/installs.json`) as the single
durable source of consent. Add optional `deliveryPolicy: off|actionable|all` to an
adapter's record. Read the new field first, then legacy
`nativeActivation.livePolicy`, then off. An invalid present field reads off.
Missing, corrupt, unreadable, or unknown-schema records disable live delivery
without failing a hook. Do not overwrite a corrupt ownership record to repair it.

Persist explicit consent even when a daemon is temporarily absent. Keep consent,
static compatibility, activation mechanisms, and current session reachability
separate in `doctor`. `--delivery off` and uninstall revoke consent for subsequent
offers once the install operation completes. A submission already accepted by the
vendor queue is not retracted; a racing in-flight offer cannot be made atomic
with vendor queue acceptance by a local file check.

Add `nativeDelivery.policySource`, a closed optional SDK field with values
`bootstrap-environment` (default, preserving Claude) and `installation-record`
(Codex). Hooks read policy on SessionStart and beforeTurn; Codex's sender path
reads it again before the transport offer. Do not cache it across offers. Explicit
off clears a hook's binding instead of skipping the native-binding path.
For a non-retired binding, current recorded consent governs both narrowing and
expansion (actionable to all); do not permanently intersect it with the old
policy snapshot. Changing off to on does not discover arbitrary unbound sessions:
a new hook is still required to establish a retired or missing binding.

The generated Codex hook pins the install's ACC data home, so a daemon that was
started without ACC-specific environment finds the right record and runtime.
Use an optional quoted `ACC_DATA_HOME` export in `writeHookShim`, emitted only
when the adapter supplies that path. Keep policy out of the generated script.
Custom CODEX_HOME must be resolved consistently by install, probe, and bind;
thread/socket identity must never be inferred from the sender's CODEX_HOME.

The Codex activation plan only describes reuse of a pre-existing vendor service:
`native-service`, `preExisting: true`, both commands null. No shell-bootstrap.
On an upgrade, reconcile previous mechanisms against desired mechanisms even
when live policy stays enabled. Remove the exact old Codex shim only if its hash
matches ownership. Preserve edited files, the user's rc text, other adapters'
shims, and pre-existing daemons. Preserve cleanup ownership for retained modified
artifacts rather than replacing the record and silently orphaning them.

## Exact receiver address

Add an adapter-owned endpoint registration under the workspace runtime directory,
using the existing Claude registration pattern as a reference. It is metadata,
not a transport service. Core receives only an opaque endpoint ID.

Registration v1 fields:

```js
{
  schemaVersion: 1,
  endpointId,             // random portable identifier, not the thread ID
  socketPath,             // receiver's absolute control-socket path
  threadId,              // exact event.sessionId
  cwd,                   // canonical absolute event.cwd
  clientVersion,          // equals initialize server version
  protocolContract: 'codex-app-server-thread-queue-v1',
  leaseUntil             // bounded reachability observation
}
```

Read only from a fixed adapter directory under runtimeDir. Validate IDs, closed
keys, types and paths; reject traversal, symlinked registration files, non-socket
endpoints and malformed records. Write atomically with private file permissions.
Use a fresh opaque ID for each successful hook binding so a late old-generation
handshake cannot overwrite a successor's address. Expired registrations may be
read for revalidation, never used as proof of current reachability.

Handshake requires a real hook-resolved client PID, a supported stable version,
the expected protocol, membership of the exact thread ID in loaded/list, and
metadata for that same ID with matching canonical cwd. Do not match the first
thread or any thread merely sharing a cwd. Do not substitute daemon cwd or
process.cwd when the event lacks cwd. Canonicalize both sides with realpath;
failure to resolve is a refusal, not a guessed match.

Keep the generic PID and version gates. In LocalDaemon, the hook ancestor can be
the Codex server process; the exact thread check supplies session specificity.
Capture this ancestry in installed E2E before accepting the implementation. A
PATH executable/server version mismatch remains degraded; do not relabel the
daemon using a newer CLI version. If real capture exposes an unresolved PID
gate, revise this design before adding a vendor-specific exception in core.

Validate queue/list response structure and bounded pagination. Timeouts, malformed
data, missing methods and exhausted/repeated cursors cannot count as a successful
probe. Install probes may use a loaded metadata-only thread; no loaded thread
means a retryable probe failure while consent can still be retained.

Every offer resolves the receiver's registration, rechecks the server version,
loaded exact thread and cwd, then uses queue/add. The final preflight and add use
the same connection. Public diagnostics contain closed reason codes, never
socket paths, raw RPC errors or endpoint IDs. A mismatch leaves the receipt queued.

## Idle lease renewal and retirement

The current hook binding expires after at most two 60-second heartbeat cadences.
Codex has no ACC channel process renewing it. A successful immediate idle test
would not establish useful long-idle delivery.

Add `includeExpired: false` to core's existing `listDeliveryBindings` query;
true includes only expired bindings of the current open generation, still
excluding retired bindings. Default behavior stays unchanged. This is a
vendor-neutral query extension, not a core transport decision.

Codex exposes optional `refreshNativeSession({binding, runtimeDir, timeoutMs})`.
The router uses it only after selecting one unambiguous, policy-permitted current
session and finding its binding expired. Validate the returned handshake against
the binding version and runtime platform, require the same opaque endpoint, cap
the new lease, then call existing `refreshDeliveryBinding`. Re-read current
generation and non-retirement before offering; a refresh must not resurrect a
closed, retired or superseded binding. Retain the normal offer's final identity
check. Adapters without refresh keep their existing expiry behavior.

No timer or daemon is introduced. Existing presence hard expiry (24 hours without
a hook heartbeat) is unchanged and documented as a limit. Endpoint cleanup is
best effort after confirmed retirement/SessionEnd. Do not add a periodic collector
or prune by timestamp alone: expired current registrations are required for idle
refresh. A delayed write from a timed-out bind can leave inert orphan metadata;
it cannot publish core reachability. Broad orphan garbage collection is deferred.

## Receipts and duplicate limits

Record the ACC message before trying transport. Queue acceptance means offered;
it does not mean read or acknowledged. `acc inbox --message` and `acc reply`
exercise the real retrieved/acknowledged transitions and resolve the original
message ID. Live-offered messages must not also be projected at the next hook.

Reuse messageId as clientUserMessageId and deduplicate while pending. Existing
settled ACC receipts prevent ordinary subsequent offers. Do not claim exactly-once
execution after queue consumption or an ambiguous acknowledgement/ACC write
failure: the vendor's queue lacks persistent idempotency in the measured version.
Test and document that boundary; a new exactly-once subsystem is outside scope.

## Evidence and acceptance

The detailed matrix and mutations are in the linked implementation plan. Real
E2E installs the candidate npm tarball in a clean prefix and invokes that copy's
CLI, hooks, registry and router. A fixture with a fake RPC server is a process
test, not a Codex capture. No direct queue/add is allowed as the positive delivery
stimulus; it must be reached through the installed ACC sender command.

Keep the historical failure fixture immutable. Add new LocalDaemon fixtures and
metadata-only provenance, with explicit A/B/C roles, observed busy ordering,
expiry duration, policy transitions, package hash and mutation results. Extend
the capture validator with a closed installed-hooks launch mode; do not reuse the
bootstrap label for a launch that has no bootstrap.

Avoid a certification bootstrap loophole: first capture the implemented native
methods from the installed tarball, using real hooks to obtain event metadata,
as transport evidence (not full product E2E). A genuine passing capture can then
anchor the candidate descriptor in the isolated branch. Repack and run the entire
product matrix through ordinary `acc` and `codex`. Do not fabricate passing
fixture fields or weaken SDK validation to run the candidate. If product E2E
fails, keep the public descriptor disabled and retain the failure evidence.

The deliverable is releasable only when the positive matrix passes, every
designated mutant fails, the complete repository/package gates pass, and a final
packed artifact reproduces the product behavior. No passing capability is inferred
from source inspection alone.
