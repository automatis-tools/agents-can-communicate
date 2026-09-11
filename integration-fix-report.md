# Integration fix report — `feat/contract-gated-activation`

Base: `0f52a9c` (the worktree was created at `280c5c9`; reset as instructed, then `npm install`).

Four real failures, all reproduced in isolation before any change and re-run green after.

---

## Failures 1 and 2 — the router refuses when no platform was supplied

`packages/cli/test/delivery-routing.test.mjs` and `packages/mcp-server/test/delivery-routing.test.mjs`,
both `queued` where `offered` was expected.

### Cause A: `platform` was silently optional

`createDeliveryRouter` destructured `platform` with no default. With nothing supplied,
`undefined` reached `evaluateVersionContract`, which answers a non-string platform with
`platform_not_captured`, and the router read any non-null reason code as a refusal —
so every live offer became `unsupported_client_version`. Both production entrypoints
(`bin/entrypoints/acc.mjs`, `bin/entrypoints/acc-mcp.mjs`) pass
`` `${process.platform}-${process.arch}` ``, so production was never affected; the defect
is that omitting the value disables live delivery silently instead of saying anything.

### Cause B: a partial contract on the fixture adapter — and it did not do what the brief says

The fixture adapter in both files declares `nativeDelivery: { policySource: "installation-record" }`
with no `minimumByPlatform` and no `anchors`.

The brief states that with a correct platform this "returns `platform_not_captured`". It does not.
`evaluateVersionContract` read `contract.minimumByPlatform[platform]` behind only a
`typeof platform === "string"` guard, so a partial declaration plus a real platform string threw
`TypeError: Cannot read properties of undefined (reading 'darwin-arm64')`. Verified directly before
changing anything. `platform_not_captured` was returned only because the platform was `undefined`
and the guard short-circuited. That mattered: the moment Cause A is fixed and a real platform
arrives, the throw becomes reachable. In the CLI and MCP seams it would have surfaced as
`transport_error` from `recordAndOffer`'s catch — a diagnostic pointing nowhere near the
declaration that caused it.

### How I decided the missing-platform behaviour

I made `platform` default to `` `${process.platform}-${process.arch}` `` — the host the router
process is running on — and documented why at the definition. Injection is unchanged and still
works, and tests rely on it.

Reasoning for a default over throwing:

- A native-delivery contract is captured per platform, and the only platform a router can
  meaningfully judge an offer against is the one it is running on. That is exactly the value
  both entrypoints already pass; there is no second correct answer in production.
- It removes the silent-disable without inventing a new failure mode. Throwing would have turned
  currently-passing suites red (`tests/native-transport-permissions.test.mjs`,
  `tests/process/delivery-bindings.test.mjs`, `packages/delivery-router/test/router-*.test.mjs`,
  plus the three failing files) for reasons unrelated to the four failures, and would contradict
  "nothing that worked before this branch stops working".
- A documented default is explicit behaviour. The parameter is no longer "optional with an
  undefined meaning"; it means "the host, unless you say otherwise".

### The fallback ruling, implemented

`packages/delivery-router/src/router.mjs`: when the contract check comes back
`platform_not_captured` or `native_delivery_unsupported` — the two codes that mean *there is
nothing to judge against*, as opposed to a capture that judged and refused — the router falls
back to the pre-branch rule: the version the client reported must equal the one recorded on the
binding. Every other reason code still refuses, and `reasonCode === null` still admits.

```js
const versionRule = evaluateVersionContract(adapter, { clientVersion: response.clientVersion, platform });
const admitted = UNCAPTURED.has(versionRule.reasonCode)
  ? response.clientVersion === binding.clientVersion
  : versionRule.reasonCode === null;
```

`packages/adapter-sdk/src/native-delivery.mjs`: `evaluateVersionContract` now answers a partial
declaration — missing `minimumByPlatform`, missing `anchors`, or a minimum with no matching
anchor — with `platform_not_captured` instead of throwing. This is the same "closed result
rather than a throw" property the module already documents for malformed probes and handshakes,
and it is what makes the router's fallback reachable rather than a crash.

### The test that pins the fallback

`packages/delivery-router/test/router.test.mjs`, two new cases:

- **"an adapter with no captured contract falls back to the version recorded on the binding"** —
  one uncaptured adapter reporting the bound version (`offered`) and one reporting a drifted
  version (`queued` / `unsupported_client_version`). The first half fails if the router refuses
  instead of falling back; the second fails if the fallback is too permissive.
  Verified by reverting `admitted` to `versionRule.reasonCode === null` and watching it fail.

- **"a router given no platform judges against the captured contract for the host it runs on"** —
  a captured adapter, no `platform` passed, reporting a version above the minimum but different
  from the bound one. That combination is the discriminator: only a real capture admits the drift,
  so it fails if the default is removed (the uncaptured fallback would refuse the drift) and it
  cannot be satisfied by the fallback alone. Verified by removing the default and watching it fail.

  This second case is worth noting: my first draft of it passed with the default removed, because
  the fallback masked it. Both pins were re-checked against a deliberately broken router.

`fixture()` in that file gained an `omitPlatform` option so a router can be built with no
platform at all (a `platform: undefined` property would just re-trigger the default).

---

## Failure 3 — the same cause on a real adapter

`tests/process/claude-native-delivery.test.mjs`, expecting `offered` / `claude-channel`,
getting `queued` / `durable` / `unsupported_client_version`.

Confirmed rather than assumed, by evaluating the real adapter directly:

- `createClaudeCodeAdapter()` with `platform: undefined` → `platform_not_captured`
- same adapter with `platform: "darwin-arm64"` → `reasonCode: null`, minimum `2.1.258`

The binding publishes `clientVersion: "2.1.258"`, `CLAUDE_CHANNEL_MINIMUM` is `"2.1.258"`, and
Claude's `offerMessage` returns `clientVersion: binding.clientVersion` — so the reported version
satisfies the capture exactly. The missing platform was the whole story; the router's default
fixes it with no change to the test.

---

## Failure 4 — a test asserting the behaviour this branch deliberately changed

`tests/acceptance/managed-update-packed.test.mjs:118`, `processes_active` vs `undefined`.

The test asserted that an update waits because an MCP process is live. Under
`blocksActivation`, a hold only waits when its declared store contract is unknown on either
side or differs from the incoming generation's. The live MCP lease declares
`control.active.storeVersion`, the candidate declares the same `accStoreVersion` (6), so it
matches and no longer blocks — the update activates and there is no reason to report.
That is the branch working as designed.

### How I rewrote it

The waiting case is kept — it is the safety half — and the new permissive case is added beside it,
so the test now covers both directions of the gate rather than one.

Restructured as:

1. **Continuity is created first.** `initialize`/`status`/`findBinding` moved ahead of the update
   loop, which also gives the test the workspace id and the real `bindings/` directory.

2. **Safety half, unknown contract.** A second native client binding is planted beside the MCP
   continuity record — the shape `storeSessionBinding` writes, sha256-named the same way, with
   `clientPid: process.pid` so the holder is genuinely alive — and with **no** `storeVersion`.
   The lock-contention loop is unchanged, and the update still reports `processes_active`; the
   notice is asserted to name `contract unknown`, `active` is unchanged, the candidate is staged,
   and the `.tgz` was fetched. The candidate's own `storeVersion` is asserted to be a safe integer,
   so the next step compares against something real rather than against `null`.

3. **Safety half, differing known contract.** The same live hold is rewritten to declare
   `staged.storeVersion + 1`. The update still reports `processes_active` and the notice names
   `store contract 7`. Known-and-equal is the only pairing that stops being a wait.

4. **Permissive half.** The foreign hold is removed. The MCP client is still running, and its
   lease is read and asserted to declare exactly `staged.storeVersion` — so the premise
   "this hold's contract matches" is pinned, not merely hoped for. The update then activates
   (`applied.activated === true`) **while that process is still alive**
   (`mcp.child.exitCode === null` afterwards). Before this branch, any live process postponed this.

5. Continuity, generation roots, old-root retention, MCP restart and owner reuse are all asserted
   as before, with `mcp.close()` moved after activation instead of before it.

The test title changed from "waits for live MCP" to "waits for a hold it cannot judge, then
switches past a matching one", since the old title now describes behaviour the branch removed.
Nothing else in the repo referenced the old title.

Both halves discriminate: if the gate blocked on every live process, step 4 fails; if it let
unknown or differing contracts through, steps 2 and 3 fail.

Two small helpers were factored into the file: `mcpLease` (which the existing idle-lease wait now
also uses, replacing its inline copy) and `writeForeignHold`.

---

## Files changed

- `packages/delivery-router/src/router.mjs` — host-platform default; uncaptured-contract fallback.
- `packages/adapter-sdk/src/native-delivery.mjs` — `evaluateVersionContract` returns a closed
  result for a partial declaration instead of throwing.
- `packages/delivery-router/test/router.test.mjs` — `omitPlatform` fixture option,
  `uncapturedAdapter` helper, two pinning tests.
- `tests/acceptance/managed-update-packed.test.mjs` — rewritten to assert the contract gate in
  both directions.

`CHANGELOG.md` untouched.

---

## Full suite

`node scripts/run-tests.mjs`, run to completion:

```
tests    2089
suites   0
pass     2087
fail     1
skipped  1
todo     0
```

The single failure is the expected one:
`tests/acceptance/recorded-candidate.test.mjs` — "the changelog's digest describes the code
that is here now". It fails by design until the release candidate is re-recorded in a separate
closing step, and its diff now also lists the four files above, which is correct.

The count moved from 2087 to 2089 because of the two pinning tests added to the router suite.

`node scripts/check-syntax.mjs` — clean, 515 files.

---

## Concerns

- **Contradiction with the brief, already noted above:** the partial fixture adapter threw a
  `TypeError` when given a real platform; it did not return `platform_not_captured`. The brief's
  conclusion (fall back rather than refuse) is unaffected and is implemented as ruled, but the
  SDK needed hardening for that fallback to be reachable at all.
- The router's uncaptured fallback stays unreachable in production, exactly as the ruling
  predicted: a native binding only exists after `evaluateNativeEligibility` passed, which requires
  a captured minimum for the running platform. It is a guard against partial adapter declarations,
  not a live code path.
- `packages/adapter-sdk/src/native-delivery.mjs` is in the recorded-candidate digest, so the
  closing re-record step will pick it up along with the other three files.
