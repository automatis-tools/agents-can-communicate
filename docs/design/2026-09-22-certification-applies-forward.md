# Certification evidence applies forward

## Problem

A capability is granted only to the exact client version and the exact platform a capture
recorded. Clients release almost daily, so the recorded set is stale the week after it is
written, and the person who updates their client is the one who loses delivery.

Measured on 2026-09-22, with `effectiveCapabilities` as it stands:

| Adapter | Evidence | Installed here | Effective |
|---|---|---|---|
| Claude Code | `delivery.nextTurn` at 2.1.233; `livePush`/`replyRoute` at 2.1.258 and 2.1.260 | 2.1.278 | nothing |
| Codex CLI | 0.147.0 … 0.153.4 | newer | nothing |
| Gemini CLI | 0.57.0 | 0.59.0 | nothing |
| Kimi | 0.36.1 | 0.42 | nothing |
| Antigravity CLI | 1.2.7 plus a `certificationFloor` | 1.2.8 | everything the floor names |

Two separate defects sit in that table.

- **Versions.** Claude Code 2.1.260 already loses `delivery.nextTurn`, because that capability
  was captured once at 2.1.233 and the later captures covered other capabilities. A capture of
  one capability silently withdraws every capability it does not mention.
- **Platforms.** Every row in every adapter is `darwin-arm64`, and the platform is matched
  exactly. On `linux-x64` and `win32-x64` every capability of every adapter resolves to
  `false`, so ACC places no message in any context on those platforms.

The Antigravity row is the exception because `certificationFloor`, added in 0.6.0, already
solves this for one adapter: 1.2.8 inherits what 1.2.7 proved. This design makes that the
general rule and removes the special case.

## Principle

A capture records where a behaviour was observed, not a licence for that one version. Evidence
therefore applies forward — from the version that recorded it until a later capture changes it —
and across platforms until a platform records something different. What the project stops doing
is demanding a fresh capture per release; what it keeps is the ability to record, in the same
format, that a client lost a capability.

Receipt integrity is unchanged: a capability that resolves to `false` still withholds bodies and
leaves receipts `queued`, and a message is never marked delivered on a guess.

## Design

### Resolution

`effectiveCapabilities(adapter, { clientVersion, platform })` resolves each capability `C` of
the `CAPABILITY_SHAPE` independently:

1. Take the adapter's evidence rows for this client and capability `C`.
2. Keep the rows whose version is less than or equal to `clientVersion`.
3. Among those, if any names this `platform`, keep only those. Otherwise keep all of them.
4. If no row remains, `C` is off: the client is older than anything this adapter observed.
5. Otherwise take the highest version among the remaining rows. `C` is on when every row at
   that version has `result: "pass"`, and the adapter itself declares `C`.

Version before platform, decided while writing the tests: a loss recorded for one platform at
1.3.0 says nothing about that platform at 1.2.3, where another platform's passing capture is
the only evidence in reach. Filtering by platform first would let a later regression reach
backwards and darken versions it never described.

A `fail` at the deciding version wins over a `pass` at the same version, which can only happen
when two platforms disagree and neither is the platform in hand. Withholding a body costs a trip
to `acc inbox`; a false "delivered" loses the message.

Versions compare as the numeric triple. A prerelease suffix compares as its triple, so
`1.3.0-rc.1` is judged as `1.3.0`. Today such a version fails `STABLE_VERSION` and resolves to
nothing at all.

### Removals

- `adapter.certificationFloor` and `validateCertificationFloor` go away. The Antigravity rows at
  1.2.7 apply forward under the general rule, which is what the floor expressed.
- `packages/adapter-antigravity/src/adapter.mjs` drops its `certificationFloor` declaration, and
  `docs/ADAPTER_AUTHORING.md` drops the field.

No compatibility shim is kept: an adapter built against the previous SDK that declares
`certificationFloor` fails validation with a message naming the field and this document.

### Refusal reasons

`packages/hook-runner/src/runner.mjs` no longer says "client X on Y is not certified for
nextTurn". Two honest reasons replace it:

- `client 2.1.100 is older than 2.1.233, the first version acc verified for nextTurn` — the
  client is below every row, and the answer is to update the client.
- `acc recorded that nextTurn stopped working in 0.42.0` — a `fail` row decides, and the answer
  is to wait for a capture that restores it.

`packages/installer/src/detect.mjs` and the `acc doctor` lines follow the same two shapes.
Both read the verdict from `capabilityEvidence(adapter, facts, capability)`, a new SDK export
returning `{ granted, reason, version }` with `reason` one of `undeclared`, `unobserved`,
`older-than-evidence` or `recorded-failure`.

### An unreadable client version

When the version probe fails, the client facts are incomplete. Today that resolves every
capability to `false`. It will instead resolve as though the version were the newest row: a hook
that is running already proves the integration is installed, and a client changing the format of
`--version` should not cost its user delivery. `acc doctor` keeps reporting that the version
could not be read.

### Recording a regression

A regression is a row with `result: "fail"` at the version where the loss was observed, with its
own fixture and provenance, exactly as `2.1.252 livePush fail` already reads. It applies forward
until a later row passes again.

The Kimi 0.42 loss of `PostToolUse` context, from the 2026-09-13 client survey, has no capture at
0.42 and therefore cannot be recorded yet. Under this design Kimi 0.42 inherits the 0.36.1 rows.
That capture is tracked separately and does not gate this change.

## Testing

- `packages/adapter-sdk/test/certification.test.mjs`: the rule itself — forward inheritance per
  capability, a later `fail` withdrawing an inherited `pass`, a later `pass` restoring it, a
  version below every row, cross-platform inheritance, a platform row overriding it, a `fail`
  winning a tie at the deciding version, and a prerelease judged as its triple.
- `packages/adapter-sdk/test/capabilities.test.mjs`: `certificationFloor` is rejected as an
  unknown field.
- Each adapter's `test/adapter.test.mjs`: the installed-version case that is dark today resolves
  to the capabilities its evidence proves.
- `packages/hook-runner/test/runner.test.mjs`: both refusal texts, and a newer-than-evidence
  version that now projects bodies and advances receipts.
- `packages/installer/test/detect.test.mjs`: the doctor lines for both refusals.
- `tests/package-certification.test.mjs`: the packaged adapters resolve the same way as the
  source tree.

## Out of scope

- Capturing any client on `linux-x64` or `win32-x64`.
- The Kimi 0.42 capture.
- `nativeDelivery.minimumByPlatform`, which is a contract minimum rather than evidence, and stays
  as it is.
- Receipt semantics, `note` reminders, and the one-time relay activation hint.

## Risks

- **A client silently breaks a capability on a version nobody captured.** ACC then offers bodies
  the client drops. Messages carrying `reply` or `acknowledge` survive this, because their
  receipts stay open until the agent answers; a `note` does not, which is the standing gap
  tracked for note delivery.
- **Cross-platform inheritance assumes the client behaves the same everywhere.** Where it does
  not, the answer is a platform row recording the difference, which this rule already prefers.
