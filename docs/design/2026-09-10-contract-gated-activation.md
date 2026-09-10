# Contract-gated activation and version eligibility

## Problem

ACC closes two gates on the identity of a process version where its own contracts
define compatibility by a declared contract version. The gates are stricter than the
invariant they protect, and they compound into a cycle a user cannot exit.

**Activation waits for every live client.** `activatePending` refuses to switch the
active generation while `listActivationBlockers` returns anything. Runtime leases hold
for each live ACC process, and native binding records hold until the owning client PID
is confirmed dead. On a machine with three Claude Code sessions and a Codex daemon, an
update requires closing the entire working environment. There is no force path.

**Native eligibility requires the CLI and the service to be the same version.**
`evaluateNativeEligibility` computes the static rule from the version of the client
binary ACC detected, then rejects the result when the running service reports a
different version:

```js
if (facts.clientVersion !== clientVersion) return closedResult("probe_version_mismatch");
```

A Codex CLI that updates while its `app-server` daemon keeps running is the common
state, not a rare one. Both versions can sit above the captured minimum and still turn
live delivery off.

**Uninstall leaves holds behind.** `acc uninstall` removes client wiring but does not
retire the binding records and runtime leases its own install produced. Live sessions
keep holding an installation that no longer exists. The same removal empties
`control.targets`, and `inspectMaintenanceServices` filters adapters by that list, so
the maintenance path that could clear a vendor-daemon hold silently declines to run.

The cycle: clearing the version mismatch wants a daemon restart; performing that
restart through the supported path wants an active runtime that carries it; activating
that runtime wants the daemon and every session to exit.

## Principle

Close a gate on the declared contract, never on the identity of a process version.

The project already states the contract for shared state. Each workspace carries
`protocol.json` with a `storeVersion`, and `packages/storage-filesystem/src/identity.mjs`
enforces it by strict equality against `STORE_VERSION`. Generations 0.4.0 through 0.4.4
all declare `STORE_VERSION = 6`, so they are already compatible by the project's own
rule while the activation gate treats them as mutually exclusive.

## Scope

In scope: the activation gate, per-session generation pinning, native delivery
eligibility, the holds `acc uninstall` leaves, and generation retention.

Out of scope: the workspace data format itself, delivery defaults, the integration
refresh fence, and the maintenance worker's own lifecycle. A `STORE_VERSION` change
keeps today's behaviour unchanged.

## Design

### Declared contract on holds

A hold states the contract it speaks, so the gate can compare contracts instead of
process versions.

Runtime leases already record `runtime.version` and `runtime.root`. They gain
`storeVersion`, read from the constant of the generation publishing the lease.

Binding records currently carry `schemaVersion`, `harnessSessionId`, `accSessionId`,
`generation`, `clientVersion`, `platform` and `clientPid`. They gain `storeVersion` and
`runtimeRoot`. The existing `generation` field names the ACC session generation, which
is credential rotation, not the runtime generation; the new field must not reuse that
name.

### Activation gate

`listActivationBlockers` keeps discovering holds exactly as it does today, including
its treatment of dead PIDs and unknown workspaces. What changes is which holds block.

A hold blocks activation when its declared `storeVersion` differs from the incoming
generation's, or when it declares none. Everything else proceeds. The notice from
`activationBlockerNotice` keeps its per-PID detail and gains the declared contract of
each blocking hold, so a wait names the reason rather than only the process.

Records written before this change declare no contract and therefore remain holds.
The first update after this ships still waits for processes to exit. Updates after
that do not.

### Per-session generation pinning

A session finishes on the generation it started with, for both its hooks and its
channel process. Long-lived processes already satisfy this: `runEntry` resolves a
generation at spawn time and the loaded code stays loaded. Hooks do not, because
`stablePaths()` names `runtime/bin/acc-hook.mjs` and `writeLaunchers()` atomically
replaces that file's contents with a new `packageRoot` on every activation.

A pin file records the session's generation at
`runtime/pins/<sha256(harnessSessionId)>.json`, naming the generation root, its version,
its `storeVersion`, the client PID, and the creation time. The first ACC code in a
session writes it. `SessionEnd` removes it. Abandoned pins are reaped by the same
confirmed-dead-PID sweep that already removes stale leases during admission.

Resolution cannot happen in `entry.mjs`. That module runs under the admission mutex
before workspace-capable code loads, and the harness session id arrives in the hook
payload on stdin, which `entry.mjs` does not read. The hook therefore starts on the
active generation, reads its payload, and delegates to the pinned generation's hook
entrypoint when the pin names a different generation that still exists on disk. The
extra process spawn is paid only by sessions that outlived an activation.

### Native delivery eligibility

`evaluateNativeEligibility` evaluates the static rule against the version that will
actually serve. When the probe reports a version, that version is the serving version.
The equality comparison against the detected binary version is removed. The
`protocol_mismatch` check stays, because a protocol contract is a contract.

The minimum, the prerelease refusal and the `knownBad` denylist all apply to the
serving version. A daemon below the captured minimum now reports `below_minimum_version`
naming that daemon's version, instead of a generic probe failure.

`validateNativeHandshake` takes the same substitution for the session handshake.

In `packages/adapter-codex/src/native-delivery.mjs`, `verifyReceiver` currently returns
`handshake_version_mismatch` whenever `probe.serverVersion` differs from the version
recorded in the binding. It instead re-evaluates the static rule against the reported
server version and refreshes the binding's recorded version when the rule still holds.
A restarted daemon usually loses the thread regardless, which `locateCodexThread`
reports independently.

The offer path carries a fourth check of the same shape. In
`packages/delivery-router/src/router.mjs`, an accepted offer is rejected with
`unsupported_client_version` when the version the adapter reports differs from the version
recorded on the binding. That comparison becomes a contract check against the same captured
minimum and denylist, reached through the binding's adapter rather than reimplemented. A
version below the minimum, or on the denylist, is still refused exactly as today.

This site is load-bearing rather than incidental. Left as an identity check, it rejects
precisely the case the other three changes exist to allow: a service that restarted onto a
different build while the binding still names the version captured when the session was bound.
The defect would move one layer up and become silent, since the message would fall back to
queued with every test still passing.

`probe_version_mismatch` stays in the native vocabulary so recorded events remain
readable. No path produces it after this change.

### Uninstall retires its own holds

`acc uninstall` retires the binding records and pins belonging to the installs it
removes, and marks the runtime leases of the ACC processes it orphaned so they stop
holding activation. It does not signal or terminate client processes. An orphaned
channel process keeps running; the existing `startInertChannel` path already covers a
channel that cannot admit a workspace.

This also removes the `control.targets` trap. After an uninstall there are no holds
left for maintenance to clear, so a subsequent install and update proceed without one.

### Generation retention

A generation directory is removed once no pin and no lease references it, under the
manager lock, and only when no live or unknown holder could still reference it. That is
the rule maintenance already applies before removing historical bookkeeping. Four
generations currently accumulate with nothing removing them.

## Compatibility

Old records are read, never rejected. A lease or binding without `storeVersion` is an
unknown contract and stays a conservative hold, which is exactly today's behaviour for
that record. A missing pin resolves to the active generation. Reason codes already
written to events keep their meaning and stay in the vocabulary.

## Error handling

| Situation | Behaviour |
|---|---|
| Pin missing or unreadable | Active generation, as today |
| Pinned generation absent from disk | Active generation, diagnostic recorded |
| Pinned entrypoint fails to import | Hook continues on the active generation |
| Hold declares no `storeVersion` | Conservative hold, current wait notice |
| Declared `storeVersion` differs | Current behaviour, wait for process exit |
| Probe reports no version | Current reason codes, unchanged |
| Integration refresh fails | Unchanged, fenced and repairs forward |

A hook never fails the client because of pin resolution. That continues the existing
rule that a hook lets the client proceed when coordination is unavailable.

## Testing

Unit coverage for eligibility: a serving version above the minimum and different from
the detected binary version is eligible; a serving version below the minimum reports
`below_minimum_version` naming it; a serving version in `knownBad` reports
`known_bad_version`; a protocol contract mismatch is unchanged.

Unit coverage for activation: holds with matching, differing and absent `storeVersion`;
the notice text for each. Unit coverage for pin resolution: present, absent, stale, and
a pinned generation removed from disk.

Acceptance coverage in the existing packed style: activation while a live session holds
the previous generation, asserting the live session's hook loads the pinned generation
and a new session loads the active one; uninstall with a live session followed by
install and update with no remaining holds; retention removing an unreferenced
generation and keeping a pinned one.

Process coverage with real clients: a Codex daemon whose version differs from the CLI
with both above the minimum, asserting live delivery turns on; and a Claude to Codex to
Claude round trip completed across an activation without closing any session.

## Limits

A `STORE_VERSION` change still requires every live process to exit. That is the case
the gate exists for, and this design does not weaken it.

Pinning is stronger than the store contract requires. With contracts compared, a hook
from a newer generation and a channel from an older one are already compatible in the
same session. Pinning is kept because a session that stays whole is easier to reason
about than one that is half upgraded.

The first update after this ships still waits for processes to exit, because the holds
it must judge were written before the contract field existed.
