# Native delivery is judged by version alone

## Problem

[Certification evidence applies forward](2026-09-22-certification-applies-forward.md) made
hook capabilities carry from the version that recorded them onward, and across platforms.
It left native live delivery out: `nativeDelivery.minimumByPlatform` names one minimum per
captured platform, and `evaluateVersionContract` answers `platform_not_captured` for any
platform absent from that map. Every shipped adapter names `darwin-arm64` alone. 0.8.0 added
the Claude Code inbox wake with the same shape.

Measured on 2026-09-26. On an Intel Mac or on Linux, with the same client versions that pass
on this machine:

| Site | What it does with `platform_not_captured` |
|---|---|
| `installer/detect.mjs` | Static refusal: doctor says "native delivery is not verified on this platform", and no activation is planned, so `acc install --delivery actionable` records consent and activates nothing |
| `hook-runner/native-binding.mjs` | Static refusal: `SessionStart` never publishes a live binding |
| `delivery-router/router.mjs` | Tolerated for an existing binding, which nothing ever creates there |
| `cli/managed-runtime/maintenance.mjs` | Special-cased as "no opinion" |
| `adapter-codex/src/maintenance.mjs`, `service-setup.mjs` | `maintenance_platform_unsupported` before any inspection |
| `adapter-codex/src/live-permissions.mjs` | `permission_configuration_uncaptured`: outgoing socket permissions are never written |
| `adapter-codex/src/maintenance-host.mjs` | Runs `/usr/sbin/lsof`, which is where macOS keeps it; Linux keeps it in `/usr/bin` |

So a Claude Code session on Linux is never woken, a Codex daemon there is never used, never
maintained and never given its outgoing permissions, and an Antigravity relay never binds.
None of that is a measured refusal. The probe and the per-session handshake already verify
the transport on the machine in hand: the socket file, the session registry entry, the
daemon's protocol answer, the served version. The platform map checks nothing they do not.

## Principle

The same one as on 2026-09-22. A capture records where a behaviour was observed. The minimum
is the first passing capture, wherever it was taken, and it applies on every platform. What
decides on the machine in hand is the current probe and the per-session handshake, which is
what the contract already required a newer version to pass.

A platform whose transport is technically different is refused by the probe as a fact about
that transport, never as a gap in the captures: Claude Code on native Windows serves a named
pipe that demands an auth line, and its probe keeps answering `native_delivery_unsupported`.

## Design

### Contract shape

```js
nativeDelivery: {
  minimum: "2.1.282",
  anchors: [{ version: "2.1.282", protocolContract: "claude-code-inbox-socket-v1" }],
  knownBad: [],
  activationKinds: ["native-service"],
  policySource: "installation-record",
  offerKind: "wake",
}
```

- `minimum` is a stable version and must equal the lowest anchor version: the first passing
  capture.
- Each anchor must have passing `delivery.livePush` evidence for this client at that version.
  The evidence row still names the platform it was taken on; that is provenance, exactly as
  it is for hook capabilities.
- `minimumByPlatform` and `anchor.platform` are rejected by `validateNativeDeliveryContract`
  with a message naming the field and this document. No shim is kept, as for
  `certificationFloor` on 2026-09-22.

### Judgement

`evaluateVersionContract(adapter, { clientVersion })` keeps these rules and no other:
`native_delivery_unsupported` for no contract, `version_unavailable` when nothing answered
with a version, `below_minimum_version`, `known_bad_version`. A hand-built declaration
missing its minimum or anchors is `native_delivery_unsupported`: a closed answer rather than
a `TypeError`, as today. `evaluateNativeEligibility` and `validateNativeHandshake` drop
`platform` from their inputs with it.

A prerelease is judged by its release triple, exactly as
[the 2026-09-22 rule](2026-09-22-certification-applies-forward.md) already judges hook
capabilities: `0.156.0-alpha.3` is `0.156.0` against `minimum` and `knownBad`, through the
triple helper `certification.mjs` gained then, not a second one. What admits any version,
prerelease or not, is the protocol contract the probe and the handshake report. The Claude
probe's stable-version test in `inbox-delivery.mjs`, Codex's `probeCodexQueue` and
`serverVersionOf` path, and the Antigravity probe, where it does the same, stop refusing a
`-pre` suffix. A version that cannot be read at all stays `version_unavailable`.

`platform_not_captured` and `prerelease_not_captured` stay in `NATIVE_REASON_CODES`, marked
as historical: native-attempt records written by earlier versions carry them, and the store
reads them unchanged. Nothing produces either any more. `NATIVE_PLATFORMS` goes with the
field that validated against it.

What may refuse live delivery is therefore exactly three things: the machine's own probe or
per-session handshake failing, a client older than the first passing capture, and a
regression recorded in `knownBad`. Nothing else: not the platform, not a prerelease suffix,
not where the evidence was taken.

### Consumers

- `installer/detect.mjs` and `hook-runner/native-binding.mjs` drop `platform_not_captured`
  from their static reasons; `installer/delivery-diagnostics.mjs` drops its text.
- `delivery-router/router.mjs` drops the uncaptured-platform tolerance and its `platform`
  option: an offer's answering version is admitted when the contract admits it, on every
  host. `bin/entrypoints/acc.mjs` and `acc-mcp.mjs` stop passing a platform to the router.
- `cli/managed-runtime/maintenance.mjs` keeps its "no opinion" reading for an adapter that
  declares no contract and drops the platform case.
- Codex: `maintenance.mjs`, `service-setup.mjs` and `live-permissions.mjs` lose their
  `darwin-arm64` checks; `maintenance_platform_unsupported` and
  `permission_configuration_uncaptured` for a platform are gone, and the outgoing-setup text
  reads "requires Codex 0.153.4 or newer". `maintenance-host.mjs` resolves `lsof` from a fixed
  list of absolute candidates, `/usr/sbin/lsof` then `/usr/bin/lsof`, taking the first that
  is an executable regular file; PATH is still never consulted for it. `/bin/ps` stays: it
  exists on macOS and on every mainstream Linux, and procps prints `lstart` in the same
  24-character form `startTimeValid` already accepts.
- Claude Code: the probe keeps refusing `win32`; the adapter's header comment and
  `inbox-delivery.mjs` stop saying "on darwin-arm64".
- Antigravity: the declaration changes shape and nothing else.
- `scripts/e2e/*-candidate.mjs` write the new shape into the candidate adapters.
- Session bindings keep recording `platform`; it is diagnostic.

### Doctor and documentation

- Doctor never prints "native delivery is not verified on this platform".
- `docs/CAPABILITIES.md`: the sentence "Native minimum-based eligibility is separate, and
  stays per-platform" goes; the native paragraphs say the captures were taken on
  `darwin-arm64`, the minimum applies on every platform, and the probe and handshake decide
  on the machine in hand. Native Windows keeps next-turn delivery for Claude Code because of
  its transport.
- `docs/CAPABILITIES.md` (native section) and `docs/ADAPTER_AUTHORING.md` (native contract
  section) each carry one short list, "What may refuse live delivery": the machine's own
  probe or per-session handshake failing; a client older than the first passing capture; a
  recorded regression in `knownBad`. Nothing else: not the platform, not a prerelease
  suffix, not where the evidence was taken. It is written where the next implementer reads,
  so this class of gate stops recurring.
- `docs/ADAPTER_AUTHORING.md` shows the new shape and rules.
- `docs/PROTOCOL.md`: "a 2.1.282 minimum, captured on darwin-arm64".
- `docs/TROUBLESHOOTING.md`: the Gemini sentence still says "Only Gemini CLI 0.57.0 on
  darwin-arm64 has package-shipped delivery certification", which 0.6.2 already made false;
  it now says certified from 0.57.0 onward, on every platform.
- `docs/RELEASING.md`: "captured minimum" instead of "captured macOS arm64 minimum".
  "An unsupported platform is an explicit skip, never a passing capture" stays: it is about
  recording evidence, which this design does not loosen. "Capture only capabilities you
  observed" gains one sentence: a capture records evidence, and it never gates beyond that
  floor.
- Each native adapter's `COMPATIBILITY.md` gets a dated note: the minimum now applies on
  every platform; Linux and Intel macOS have no capture of their own, and the probe and
  handshake admit them.
- `CHANGELOG.md` gets an `Unreleased` section and
  `docs/release-evidence/unreleased-native-delivery-platforms.md` its record.

## Testing

Test first, each seen failing for its stated reason.

- `packages/adapter-sdk/test/native-delivery.test.mjs`: the new shape validates; `minimum`
  must equal the lowest anchor; an anchor needs passing evidence at its version on any
  platform; `minimumByPlatform` and `anchor.platform` are rejected naming this document;
  the same verdict for the same version whatever platform the caller names, including none;
  a partial hand-built declaration is `native_delivery_unsupported`.
- `packages/delivery-router/test/router.test.mjs`: an offer on a host the captures never
  named is admitted when the answering version satisfies the minimum and refused below it,
  the same as on the captured host; the equality-with-binding rule is gone.
- `packages/hook-runner/test/native-binding.test.mjs`: a bind on `linux-x64` reaches the
  handshake and goes live like one on `darwin-arm64`.
- `packages/installer/test/detect.test.mjs`: eligibility on `linux-x64` equals
  `darwin-arm64` for the same probe; no platform line in doctor.
- `packages/cli/test/managed-runtime-maintenance.test.mjs`: the other-platform case follows
  the contract.
- `packages/adapter-codex/test/maintenance.test.mjs`, `service-setup.test.mjs`,
  `live-permissions-install.test.mjs`: `linux-x64` proceeds to inspection, setup and
  permissions; `lsof` is taken from `/usr/bin` when `/usr/sbin` has none, and neither from
  PATH.
- An adapter-codex test runs the real `/bin/ps -p <own pid> -o lstart=,command=` and the
  real `lsof` resolution on the host it runs on, so the `ubuntu` job of the CI matrix
  measures Linux; this repository has no Linux machine of its own. It passes on a host
  without `lsof` while still measuring one that has it: resolution returns the first
  executable candidate when one exists and reports absence otherwise, and verification then
  fails closed with `daemon_socket_unproven`. The test is never skipped. The evidence file
  says whether the ubuntu job had `lsof`, read from its log after the push, or that this is
  unknown until the pull request runs.
- `packages/adapter-sdk/test/native-delivery.test.mjs`, `packages/delivery-router/test`,
  `packages/adapter-claude-code/test`, `packages/adapter-codex/test`: a `0.156.0-alpha.3`
  Codex daemon above the minimum is eligible and admitted by the router; a `2.2.0-beta.1`
  Claude executable with the inbox is eligible; a prerelease below the minimum is
  `below_minimum_version`.
- `tests/conformance/adapter-contract.mjs`: every anchor is eligible on a platform the
  adapter never captured when the probe reports the anchored contract, and a probe with
  another contract is `protocol_mismatch`.
- Each native adapter's `test/adapter.test.mjs` reads the new shape.

## Out of scope

- Capturing any client on Linux, Intel macOS or Windows. Evidence stays where it was taken.
- Claude Code's Windows named pipe.
- Hook capabilities, receipts, consent, and the activation gate.

## Risks

- **Linux and Intel macOS are admitted unmeasured.** The probe and handshake refuse a
  transport that does not answer, and a wake or queue add that fails is recorded as a failed
  offer with durable fallback, as it is today on darwin-arm64 when the daemon is gone.
- **Codex maintenance stops and starts a vendor daemon on hosts where those commands were
  never run.** Every identity check stays: PID record, start time, executable path, socket
  ownership, served version, and a busy service is never stopped. A host where `ps` or `lsof`
  answers in another shape fails those checks closed, with `daemon_identity_unavailable` or
  `daemon_socket_unproven`, and maintenance stays open.
