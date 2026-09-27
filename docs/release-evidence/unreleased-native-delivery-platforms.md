# Unreleased native delivery judged by version alone

Implements [the 2026-09-26 design](../design/2026-09-26-native-delivery-across-platforms.md).
The defect it removes was found by reading the contract after the first real 0.8.0 update:
every shipped native adapter declared `minimumByPlatform: { "darwin-arm64": … }`, so on an
Intel Mac or on Linux `evaluateVersionContract` answered `platform_not_captured`, and seven
sites read that as a refusal. The probe and the per-session handshake already verified the
transport on the machine in hand; the platform map checked nothing they did not.

## What changed

### The contract

`nativeDelivery` declares one `minimum` and `anchors` naming a version and a protocol
contract. `minimumByPlatform` and an anchor `platform` are refused with a message naming the
field and the design. The minimum must equal the lowest anchor, and an anchor is proven by a
passing `delivery.livePush` evidence row at its version on any platform. `NATIVE_PLATFORMS`
is gone with the field it validated.

### The judgement

`evaluateVersionContract(adapter, { clientVersion })` answers `native_delivery_unsupported`
for no contract or a hand-built declaration missing its minimum or anchors,
`version_unavailable` when no version can be ordered, `below_minimum_version` and
`known_bad_version`. It never answers `platform_not_captured` or `prerelease_not_captured`;
both stay in `NATIVE_REASON_CODES` as historical, so native-attempt records written by
earlier versions still read. `evaluateNativeEligibility` and `validateNativeHandshake` take
no `platform`.

A prerelease is judged by its release triple through `versionOrder` and
`compareVersionOrder`, the helpers `certification.mjs` gained on 2026-09-22 and now exports.
`knownBad` still names stable versions, and a prerelease of a denylisted release is on it.

### Consumers

- `hook-runner/native-binding.mjs` and `installer/detect.mjs` keep four static reasons;
  `installer/delivery-diagnostics.mjs` drops the two texts.
- `delivery-router` drops its `platform` option, the host constant and the tolerance that
  admitted a bound version on an uncaptured platform; `bin/entrypoints/acc.mjs` and
  `acc-mcp.mjs` stop passing one. An offer is admitted when the contract admits the answering
  version, on every host.
- `cli/managed-runtime/maintenance.mjs` keeps its "no opinion" fallback for an adapter with no
  contract and drops the platform case.
- Claude Code: `inbox-delivery.mjs` and `inbox-endpoint.mjs` order versions by triple; the
  probe still refuses `win32`.
- Codex: `app-server-client.mjs` exports `versionOrder` and `compareVersions` in place of
  its stable-only parsers; `probeCodexQueue` answers `version_unavailable` for an unreadable
  server version; `maintenance.mjs`, `service-setup.mjs` and `live-permissions.mjs` lose
  their `darwin-arm64` checks and `maintenance_platform_unsupported`; the maintenance CLI
  version accepts a prerelease suffix; `maintenance-host.mjs` resolves `lsof` from
  `LSOF_CANDIDATES` (`/usr/sbin/lsof`, then `/usr/bin/lsof`) with `constants.X_OK`, never
  from PATH, and `verifyMaintenanceProcess` fails closed with `daemon_socket_unproven` when
  none exists.
- Antigravity: the declaration changes shape; its probe already read a release triple.
- `scripts/e2e/*-candidate.mjs` write the new shape.

### Documentation

`docs/CAPABILITIES.md`, `docs/ADAPTER_AUTHORING.md`, `docs/PROTOCOL.md`,
`docs/TROUBLESHOOTING.md`, `docs/RELEASING.md` and `docs/ARCHITECTURE.md` say the minimum
applies on every platform and that a prerelease is judged by its triple. `CAPABILITIES.md`
and `ADAPTER_AUTHORING.md` each carry the list of the three things that may refuse live
delivery. The three native adapters' `COMPATIBILITY.md` gain a dated note.

## Tests

Each new or changed test was seen failing for its stated reason before the change that
made it pass.

- `packages/adapter-sdk/test/native-delivery.test.mjs`: the new shape; `minimum` equal to the
  lowest anchor; evidence on any platform proves an anchor; the old keys refused naming the
  design; the same verdict for eight platform values including none; partial declarations as
  `native_delivery_unsupported`; prereleases above, at and below the minimum and on the
  denylist; an unreadable version as `version_unavailable`; the handshake admitted on
  `linux-x64`, `win32-x64` and for a prerelease.
- `packages/delivery-router/test/router.test.mjs`: an answering version above the minimum is
  admitted whatever host the router runs on; `1.3.0-rc.1` above the minimum is offered and
  `1.2.2-rc.1` below it is refused; a declaration that captured nothing refuses even the
  bound version. `refresh-binding.test.mjs` drops its platform case.
- `packages/hook-runner/test/native-binding.test.mjs`: a bind on `linux-x64`, `darwin-x64`
  and `win32-x64` goes live like one on `darwin-arm64`; a `2.2.0-beta.1` session goes live.
- `packages/installer/test/native-activation.test.mjs`: a client whose version neither the
  binary nor the probe can name is `unsupported` with `version_unavailable`.
- `packages/cli/test/managed-runtime-maintenance.test.mjs`: a contract captured on another
  platform judges the daemon all the same; `0.151.0-rc.1` satisfies a 0.150.0 minimum and
  `0.149.0-rc.1` does not.
- `packages/adapter-claude-code/test/inbox-delivery.test.mjs`: a `2.2.0-beta.1` executable
  with the inbox probes as supported; `2.1.281-rc.1` is below the minimum; `unknown` is
  `feature_probe_failed` at the probe and `version_unavailable` at the bind; a tampered
  endpoint record with an unorderable version is refused at the write.
- `packages/adapter-codex/test/app-server-client.test.mjs`: a `0.156.0-alpha.3` daemon is
  supported; `0.152.0-rc.1` is below the minimum; a daemon naming no version is
  `version_unavailable`.
- `packages/adapter-codex/test/maintenance.test.mjs`, `service-setup.test.mjs`,
  `live-permissions-install.test.mjs`: `linux-x64`, `darwin-x64` and `linux-arm64` are
  inspected, prepared and given outgoing permissions like `darwin-arm64`; `0.153.3-rc.1` gets
  no permissions and `0.154.0-beta.2` does.
- `packages/adapter-codex/test/maintenance-host.test.mjs` (new): `lsof` resolution takes the
  first executable candidate and reports absence otherwise; a host without `lsof` fails
  verification closed with `daemon_socket_unproven`, and one with it under `/usr/bin`
  verifies; a `0.155.0-beta.1` CLI is accepted and `0.153.9-rc.1` refused; and, never
  skipped, this host's real `/bin/ps -p <own pid> -o lstart=,command=` answers in the
  24-character form and its real `lsof` resolves to a candidate or to nothing, logged as
  `maintenance host on <platform>: lsof <path|absent>`.
- `tests/conformance/adapter-contract.mjs`: every anchor is eligible on four platform values
  when the probe reports the anchored contract; another contract is `protocol_mismatch`; an
  older client is `below_minimum_version`.
- `tests/process/codex-live-fallback.test.mjs`: the reason a live route is missing is the
  missing daemon on every host.

Every changed production line was mutated and a test failed each time: 10 on the SDK
contract, 5 on the SDK triple judgement, and 17 across the router, hook, installer, CLI
maintenance, Claude, and Codex files. The mutants that first survived got their own tests:
the SDK's text and anchor-version checks, the installer's static `version_unavailable`, the
Claude bind's unreadable version and the endpoint record's version, the Codex probe's
unreadable server version and the maintenance CLI's prerelease suffix. One mutant was
equivalent, a null guard in `live-permissions.mjs` that `compareVersions` already covered,
and that line was removed.

## Measured on this host

`maintenance host on darwin-arm64: lsof /usr/sbin/lsof` here, and
`maintenance host on linux-x64: lsof /usr/bin/lsof` in the pull request's ubuntu job
(run 36287380564), so the second candidate is the one Linux needs.

That first ubuntu run also failed five tests that encoded the platform gate themselves:
`tests/acceptance/delivery-setup-packed.test.mjs`,
`managed-update-degraded-packed.test.mjs`, `codex-service-preparation-packed.test.mjs`
and `codex-live-permissions-packed.test.mjs` kept a `captured` flag or a skip for any host
but darwin-arm64, and `tests/process/claude-inbox-install.test.mjs` expected "not verified
on this platform" there. The macOS suite never reached those branches. They now expect the
same on every host, which puts the packed Codex service preparation, its live permissions
and the Claude consent flow under the ubuntu job for the first time.

That job then found the first real Linux difference: `lsof -Fn` names a Unix socket as
`/path type=STREAM` on Linux, and the socket proof compared the line whole, so the packed
service preparation started its daemon and then reported `daemon_socket_unproven`.
`socketListedIn` now reads the name as the text before the first ` type=`, compared whole;
the host test binds a socket and finds it in the real `lsof` output of the host it runs on,
so either shape is measured wherever the suite runs.

`npm test` on the evidence commit `20e41ee`, with `main` at `6b6f1c9` merged in: 2,640 tests, 2,639 passing, 0 failing, 1 skipped.
The skipped test is the existing uninstall check that skips on a machine where Gemini CLI is
installed, as on `main`. Nothing was re-run.

## Exact local artifact

- Source: clean commit `4642e74b774679f6d078b01eb4a7b661c3c47c72` on `feat/native-delivery-platforms`, with `main` at `6b6f1c9` (#204) merged in
  at `00c5416`.
- Archive: `agents-can-communicate-0.8.0.tgz`, packed from that commit.
- Size: 472,123 bytes; 311 packed entries.
- SHA-256: `929d20311a0c5325ef639a6ac338c10beef44645f4cb6c98a9aeb1be1a5ed7a6`.
- Package version remains `0.8.0`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
