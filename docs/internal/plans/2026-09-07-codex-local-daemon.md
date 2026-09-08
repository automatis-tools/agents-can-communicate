# Codex LocalDaemon Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execute inline; no delegation is requested.

**Goal:** Deliver ACC messages to the exact existing Codex LocalDaemon thread,
without changing its launch arguments, and prove the installed product with real E2E.

**Architecture:** Persist consent in the existing installation record. Bind an
adapter-owned receiver address from real hook/thread metadata, revalidate it at
offer time, and renew expired reachability on demand. Keep durable messaging and
the current generation/retirement rules authoritative.

**Tech Stack:** Node >=24, ESM, node:test, built-in fs/net/crypto/child_process;
Codex App Server JSON-RPC over its local WebSocket control socket.

**Spec:** [Codex LocalDaemon design](../specs/2026-09-07-codex-local-daemon-design.md).

## Global Constraints

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

Production modules and focused test files stay below 300 lines unless a cohesion
header explains the exception. Put new helpers beside their owner; do not split
unrelated modules. This work is one dependent delivery change, not independent
installer, transport, and certification releases.

## Preparation and execution order

- [ ] Read the spec, AGENTS.md, docs/CONCEPTS.md, docs/ARCHITECTURE.md and relevant
  adapter COMPATIBILITY.md. Inspect ACC coordination state and claim exact files.
- [ ] Continue from the plan branch in an implementation worktree under
  `.gitworktrees/`; never edit main. Check `git status` before every mutation.
- [ ] Run `npm ci`, `npm run check`, `npm test` once as the implementation baseline.
  Record existing failures separately. Do not fix an unrelated peer branch here.
- [ ] Implement Tasks 1–5 with public Codex native capability still disabled.
- [ ] Run Task 6's real installed-method capture, then wire the candidate and run
  full product E2E. Complete Task 7 only after the required observations exist.

Task commits are focused review units; mutation edits are restored before commit.
For every mutation, retain command, changed expression, intended failing assertion,
nonzero exit, restored diff and subsequent pass. A syntax/import failure is not a
valid mutation result.

## Task 1: Durable consent and hook/runtime policy plumbing

**Files:**

- Create `packages/installer/src/live-policy.mjs` and
  `packages/installer/test/live-policy.test.mjs`.
- Modify `packages/installer/src/{ownership,native-activation,index,apply}.mjs`.
- Modify `packages/adapter-sdk/src/native-delivery.mjs` and
  `packages/adapter-sdk/test/native-delivery.test.mjs`.
- Modify `packages/adapter-sdk/src/hook-shim.mjs`,
  `packages/adapter-sdk/test/hook-shim.test.mjs`,
  `packages/adapter-codex/src/install.mjs`, and `packages/cli/src/install-command.mjs`.
- Modify `packages/hook-runner/src/{runner,native-binding}.mjs` and
  `packages/hook-runner/test/native-binding.test.mjs`.
- Modify `bin/acc.mjs`, `bin/acc-mcp.mjs`, `packages/cli/src/main.mjs`,
  `packages/delivery-router/src/router.mjs`, and their delivery-routing tests.

**Interfaces:**

```js
// installer: only ownership.mjs writes the installation record
livePolicyOf(install); // deliveryPolicy first, legacy activation second, else off
readInstalledLivePolicy({ dataHome, adapterId }); // Promise<'off'|'actionable'|'all'>
recordInstall({ dataHome, adapterId, version, artifacts, deliveryPolicy,
  nativeActivation, accVersion, createdDirectories });
// SDK: optional contract field; omitted means bootstrap-environment
nativeDelivery.policySource; // 'installation-record' | 'bootstrap-environment'
writeHookShim({ dir, adapterId, dataHome, runner, node, name });
// router: composition roots supply the actual data home, not cwd-derived guesses
createDeliveryRouter({ service, adapters, clock, platform, readLivePolicy });
// readLivePolicy({adapter, binding}) -> Promise<policy>
// Default: off for installation-record; binding.livePolicy for legacy adapters.
```

- [ ] Add the consent reader tests before implementing it. Concrete assertions:

  ```js
  assert.equal(livePolicyOf({ deliveryPolicy: 'off',
    nativeActivation: { livePolicy: 'all' } }), 'off');
  assert.equal(livePolicyOf({ nativeActivation: { livePolicy: 'actionable' } }), 'actionable');
  assert.equal(livePolicyOf({ deliveryPolicy: 'ALL',
    nativeActivation: { livePolicy: 'all' } }), 'off');
  assert.equal(livePolicyOf({}), 'off');
  ```

  Use a temporary data home and real `recordInstall`/`loadOwnership` for the reader
  tests. Corrupt the JSON in a dedicated test directory and assert the reader
  returns off without changing bytes. Unknown schema and missing file also read off.
- [ ] Run `node --test packages/installer/test/live-policy.test.mjs`; first failure
  may identify the absent API. Then implement strict precedence and bounded
  fail-open reads. Store `operation.livePolicy`, even if effective activation is off.
- [ ] Add the SDK field with closed validation/default; preserve existing Claude
  manifests unchanged. An invalid policySource must throw, not fall back silently.
- [ ] Add optional dataHome export to the generated hook shim using its existing
  shell-quoting helper. Pass the install data home from Codex install only. Resolve
  `context.codexHome` from explicit CODEX_HOME, otherwise the supplied home/.codex.
  Test paths containing spaces, apostrophes, `$()` and backticks as literal paths.
- [ ] Hook openContext retains the resolved dataHome; resolve installed policy
  inside bindNative. Remove beforeTurn's environment-only skip, so off can retire
  a previous binding. Pass hook `env` explicitly to adapter bind for socket lookup.
- [ ] Resolve the current recorded policy in CLI and MCP composition callbacks.
  Router replaces its snapshot-only permitted-bindings filter with current-policy
  evaluation, then reads policy again immediately before refresh/offer; for recorded
  policy use the current recorded value, allowing both narrowing and expansion
  for an existing non-retired binding. Never revive a retired binding. A missing
  callback disables an installation-record adapter. Keep Claude's env activation.
  Test `actionable` binding plus newly recorded `all` with a note: it must reach
  offer without waiting for another recipient hook. Otherwise the first filter
  would silently defeat the later policy read.
- [ ] Test an old `all` binding with recorded off: the durable send succeeds,
  receipt stays queued, adapter offer call count is zero. Test actionable rejects
  note, permits question/request/answer; all permits note. Same assertions through
  CLI and MCP, not only a direct router call. Test a failed reader stays queued.
- [ ] Mutations: prefer old environment over recorded off; skip policy-off
  retirement; omit the shim's dataHome export. Each must fail its behavioral test.
- [ ] Run focused installer, SDK, hook, CLI/MCP/router tests and commit
  `feat: read native delivery consent from installation records`.

## Task 2: Remove Codex launch rewriting and reconcile old ownership

**Files:**

- Modify `packages/adapter-codex/src/native-delivery.mjs`.
- Modify `packages/installer/src/{plan,apply,native-activation,ownership}.mjs`.
- Create `packages/installer/test/native-activation-migration.test.mjs`.
- Modify `packages/adapter-codex/test/native-delivery.test.mjs`,
  `tests/process/native-shell-bootstrap.test.mjs`, and
  `packages/cli/test/native-delivery-doctor.test.mjs`.

**Interfaces:**

```js
planNativeActivation({ detection, context, livePolicy });
// eligible plan, only when probe is eligible:
({ eligible: true, reasonCode: null, mechanisms: [
  { kind: 'native-service', serviceId: 'codex-app-server',
    preExisting: true, applyCommand: null, teardownCommand: null }
] });
// installer internal, pure: compare kind plus command/serviceId/artifactIds
planActivationRetirements({ previous, desired }); // previous mechanisms to retire
```

- [ ] Write a test with recorded Codex shell shim + shared Claude shim + live
  policy actionable. Plan another actionable install with only native-service.
  Assert the plan retires the old Codex shell mechanism; dry-run does not mutate.
- [ ] Change Codex activation to the exact plan above. Probe context receives
  `env: context.env` explicitly. Non-zsh shells must not produce unsupported_shell
  when no shell-bootstrap is requested. No daemon start/stop commands are emitted.
- [ ] Implement mechanism reconciliation for enabled-to-enabled migration. Apply
  only the planned retirements. Reuse existing hash/rc-block protection. A modified
  shim is kept with a diagnostic and cleanup ownership preserved; a shared PATH
  block remains while Claude uses it. Do not delete user aliases/functions.
- [ ] Exercise migration twice: no duplicate entries or lost cleanup authority.
  Exercise failure between teardown and record publication, then rerun. Preserve
  the pre-existing service and make actual retained artifacts visible in doctor.
- [ ] Assert launch plans and installed files contain no generated Codex wrapper.
  A fake vendor command records argv to prove ordinary invocation with existing
  --cd, relative cwd, resume and config options receives byte-identical arguments.
- [ ] Mutations: restore the remote prefix; suppress enabled-to-enabled cleanup;
  remove a modified shim without checking its fingerprint. Require corresponding
  launch, migration, and retained-file assertions to fail.
- [ ] Run focused migration/bootstrap/doctor tests and commit
  `fix: retire the Codex remote launch wrapper safely`.

## Task 3: Receiver registration and exact-thread protocol checks

**Files:**

- Create `packages/adapter-codex/src/native-endpoint.mjs` and
  `packages/adapter-codex/test/native-endpoint.test.mjs`.
- Modify `packages/adapter-codex/src/{app-server-client,native-delivery}.mjs`.
- Modify `packages/adapter-codex/test/native-delivery.test.mjs` and
  `tests/process/codex-native-delivery.test.mjs`.
- Modify `packages/hook-runner/src/{native-binding,runner}.mjs` and
  `packages/adapter-sdk/src/capabilities.mjs` for optional retirement cleanup;
  cover it in `packages/hook-runner/test/native-binding.test.mjs`.

**Interfaces:**

```js
// adapter-owned endpoint directory: runtimeDir/codex-native-endpoints
writeNativeEndpoint({ runtimeDir, record }); // atomically persists spec v1 record
readNativeEndpoint({ runtimeDir, endpointId }); // valid record or null
removeNativeEndpoint({ runtimeDir, endpointId }); // best-effort own file only
retireNativeSession({ binding, runtimeDir }); // calls removeNativeEndpoint after core retirement
locateCodexThread(peer, { threadId, cwd });
// success: {found:true, threadId, cwd, status}; failure: found:false + safe reason
bindNativeSession({ event, clientPid, clientVersion, runtimeDir, env, timeoutMs });
refreshNativeSession({ binding, runtimeDir, timeoutMs }); // same SDK handshake shape
offerMessage({ binding, message, runtimeDir, timeoutMs }); // no sender env routing
```

- [ ] Add real filesystem tests for the closed record schema in the spec:
  malformed ID, traversal, symlink, wrong socket type, missing record, expired
  observation, atomic publication and private permissions. A read may return an
  expired record only as metadata for fresh verification, not as an accepted offer.
- [ ] Expand the socket process test to two daemons and two threads in one cwd.
  Build a valid binding from receiver B's hook, then change sender CODEX_HOME to A.
  Assert only B's exact thread queue grows. This test uses real sockets plus a fake
  vendor server and is labelled a process test, never real-client certification.
- [ ] Strengthen `locateCodexThread`: require exact loaded ID and canonical cwd
  equality; return observed cwd. Reject missing metadata, unknown status, repeated
  pagination cursors and exhausted page budget. Only idle/active threads qualify.
- [ ] Tighten queue probing: require valid list structure for an actual loaded
  thread. An arbitrary caught RPC exception must not mean method support. Assert
  malformed response, timeout, missing method and wrong server version all refuse.
- [ ] Implement bind: canonical event cwd, receiver socket, stable matching server
  version, exact thread, queue protocol, then a fresh random registration ID and
  bounded lease. Return only the closed SDK handshake. Keep public adapter wiring
  disabled at this step. Never invent a passing certification entry for tests.
- [ ] Implement refresh using the registration's saved receiver socket/cwd/ID;
  it returns the same endpoint ID with a fresh lease only after all checks pass.
  Offer repeats identity/version validation on the same connection before add.

  ```js
  const checked = await locateCodexThread(peer,
    { threadId: endpoint.threadId, cwd: endpoint.cwd });
  if (!checked.found) return rejected('recipient_unavailable');
  // Continue with addCodexQueueMessage only after version and protocol checks.
  ```

- [ ] Test cwd changed after binding, thread unloaded, mismatched initialize
  version, socket replaced, missing event.cwd, symlink-equivalent cwd, and names
  containing spaces. Each rejection must leave queue/add call count zero.
- [ ] Hook runner reads the previous binding before retirement, confirms retirement
  succeeded, then calls optional adapter.retireNativeSession with that exact
  binding/runtimeDir. Apply the same cleanup on SessionEnd. Validate the optional
  method's type in SDK capabilities. A successor's fresh random endpoint must not
  be removed. Do not prune merely expired records needed for idle refresh. Late
  timed-out writes can leave inert metadata; broad orphan collection is deferred.
  Use the existing store port for the two metadata reads:

  ```js
  const prior = await service.store.ephemeral.get('deliveryBinding', sessionId);
  await service.clearDeliveryBinding({ sessionId, generation });
  const after = await service.store.ephemeral.get('deliveryBinding', sessionId);
  if (prior?.generation === generation && after?.generation === generation
      && after.retiredAt != null && typeof adapter.retireNativeSession === 'function') {
    await adapter.retireNativeSession({ binding: prior, runtimeDir });
  }
  ```

  Keep this cleanup in a bounded fail-open helper; a read/cleanup error cannot
  prevent the primary core retirement attempt or fail the hook. Test a successor
  appearing between the two reads and require its endpoint file to remain intact.
- [ ] Mutations: drop cwd comparison; select the first loaded ID; resolve socket
  from sender env; treat queue/list timeout as support. Each must fail a transport
  assertion, not a parser/import assertion.
- [ ] Run adapter and socket-process tests; commit
  `feat: bind Codex delivery to verified receiver endpoints`.

## Task 4: Renew expired bindings on demand without reviving retirement

**Files:**

- Modify `packages/core/src/delivery-bindings.mjs` and
  `packages/core/test/delivery-bindings.test.mjs`.
- Modify `packages/delivery-router/src/router.mjs`; extract the new focused helper
  `packages/delivery-router/src/refresh-binding.mjs` if needed to keep it readable.
- Create `packages/delivery-router/test/refresh-binding.test.mjs`.
- Modify `packages/delivery-router/test/router-receipt-state.test.mjs` and
  `packages/adapter-sdk/src/capabilities.mjs` to validate the optional refresh method.

**Interfaces:**

```js
service.listDeliveryBindings({ participantId, now, includeExpired: false });
// includeExpired:true still excludes closed, retired and wrong-generation records.
refreshExpiredBinding({ service, adapter, binding, runtimeDir, platform, clock,
  timeoutMs: 750 }); // Promise<boolean>; false leaves message durable
// Uses adapter.refreshNativeSession and SDK validateNativeHandshake.
```

- [ ] With the existing in-memory core test harness, publish a binding, move the
  fake clock beyond leaseUntil, and assert default list is empty while explicitly
  including expiry returns the binding. Retire it and assert both lists are empty.
- [ ] Add router tests with an expired binding and a successful counted refresh.
  Assert one refresh, one subsequent offer, offered receipt, and bounded new lease.
  With no refresh method, assert queued and zero offer calls (Claude regression).
- [ ] Implement optional query behavior and refresh helper. Require a valid
  handshake, same endpoint, same version, current platform, finite future lease
  capped to 120 seconds; call existing generation-checked refreshDeliveryBinding.
  Re-read the binding afterwards. Never republish it to overcome retirement.
- [ ] Insert barriers in tests: close session during refresh; retire during RPC;
  publish a successor generation before response; remove endpoint; revoke policy.
  Every case must leave offer count zero. Two live sessions remain ambiguous even
  if only one is reachable. Never choose a recipient by most recent activity.
- [ ] Keep existing 24-hour presence expiry and document it. Do not spoof a hook
  heartbeat merely because a daemon socket exists. A daemon is not a thread.
- [ ] Mutations: return expired bindings by default; include retired bindings;
  replace refresh with publish; skip the post-refresh generation check. Require
  distinct assertions to fail and restore each edit.
- [ ] Run core binding/router/package-boundary tests; commit
  `feat: revalidate expired native delivery bindings on demand`.

## Task 5: Installed-package harness and honest capture contracts

**Files:**

- Create `scripts/e2e/codex-local-daemon.mjs` (orchestration),
  `scripts/e2e/codex-local-daemon-client.py` (stdlib PTY driver),
  `scripts/e2e/codex-local-daemon-evidence.mjs` (closed evidence + assertions), and
  `scripts/e2e/codex-local-daemon-scenarios.mjs` (matrix actions).
- Create `tests/spikes/codex-local-daemon-evidence.test.mjs`.
- Modify `scripts/spikes/delivery-capture.mjs`, `tests/spikes/capture-contract.test.mjs`,
  `scripts/spikes/check-native-captures.mjs`, `tests/spikes/native-capture-checkpoint.test.mjs`.
- Modify package certification audits only where they explicitly require bootstrap.

**Interfaces:**

```text
node scripts/e2e/codex-local-daemon.mjs --tarball /absolute/candidate.tgz \
  --codex /absolute/codex --phase transport --output /private/tmp/acc-codex-run
node scripts/e2e/codex-local-daemon.mjs --tarball /absolute/candidate.tgz \
  --codex /absolute/codex --phase product --output /private/tmp/acc-codex-run
```

The harness accepts only explicit paths and phases; exit 0 means every required
scenario for that phase passed, not skipped. Missing binary/auth/PTY support is
a named nonzero prerequisite failure. It does not silently substitute a fake
server. Python is test-only stdlib PTY support, not a package dependency.

- [ ] Build the evidence validator first, with synthetic samples clearly marked
  as unit fixtures. `assertScenarioEvidence(record)` requires case ID, phase,
  client version, role identifiers, ordered timestamps, closed observed outcomes,
  package hash, assertion counts and cleanup result. Reject zero observations,
  unknown fields, prompt/transcript/body fields and missing required case IDs.
- [ ] Extend the general capture contract with
  `ordinary-command-with-installed-hooks` as a passing launch mode. Keep old
  bootstrap captures valid. For new Codex certification require the associated
  installed-product evidence validator; a manual invocation alone cannot pass.
  Transport-phase evidence is explicitly not an installed-product launch claim.
  Keep transport captures in a separate narrow schema with observed livePush
  facts; do not force unobserved reply/fallback fields to pass. These can anchor
  the private candidate at SDK construction, but cannot pass final product
  certification audits or replace the required installed-product capture.
- [ ] Package with `npm pack --pack-destination /private/tmp/<run>`, install the
  returned tarball into a clean npm prefix, and resolve every ACC executable and
  hook from that installation. Record package SHA-256. Confirm no path points
  back to the repository's bin, packages, or node_modules.
- [ ] Create short temporary paths (Unix socket path <104 bytes), data home, custom
  CODEX_HOME, daemon project A, recipient project B and unrelated project C. Start
  with plain directories without Git. Pin exact vendor binary/version. Never
  repurpose shell HOME variables; pass isolated home values in child spawn env.
- [ ] Start the owned vendor daemon in A **before** ACC install/opt-in and without
  ACC_NATIVE_DELIVERY_POLICY or ACC_DATA_HOME in its environment. Then run installed
  `acc install --adapter codex --delivery actionable --yes --json` using the isolated
  home/data home and CODEX_HOME. Assert applied operations and empty failures, not
  just exit zero. Handle the actual client's hook trust dialog; do not claim trust
  by editing ACC's own record. Launch ordinary Codex clients in B and C.
- [ ] Use the PTY driver only for startup, trust and synthetic diagnostic prompts.
  Consume terminal bytes ephemerally; never write terminal transcripts. A small
  metadata observer may wrap the **real generated hook**, retaining only event,
  ID, cwd, process identity and timestamps while preserving stdin/stdout/exit.
  Also run the base product path without that observer to detect instrumentation
  effects. Codex-owned temporary session storage is deleted at cleanup.
- [ ] The product phase sends via installed `acc message/request`; receives via
  the shipped hook/binding/router; the model uses the installed skill's absolute
  ACC command to read/reply. No direct queue/add in this positive path. Use direct
  read-only queue/thread inspection for assertions only, with closed metadata.
- [ ] Automate deadline-based waits for hooks/markers/status. Busy requires an
  observed PreToolUse and active state before send, queue pending during that
  interval, Stop before follow-up UserPromptSubmit, and ordered marker completion.
  Never classify a pasted draft or a fixed sleep after typing as busy evidence.
- [ ] Implement finally cleanup with owned PIDs, isolated daemon stop and temporary
  credential-link removal. Preserve only sanitized evidence; do not retain raw
  user auth, hook bodies, protocol traffic or vendor transcripts. Failure cleanup
  also records its outcome and cannot turn a failed scenario into a pass.
- [ ] Mutate evidence input: empty scenario list, swap A/B equality outcomes,
  move queuedAt beyond first Stop, omit package identity. Validator must fail each
  exact assertion. Run the synthetic validator/capture tests; commit
  `test: add installed Codex LocalDaemon capture harness`.

## Task 6: Real-client transport proof, then complete product E2E

**Files:**

- Modify `packages/adapter-codex/src/adapter.mjs` only after real transport proof.
- Create distinct transport/product capture files under
  `packages/adapter-codex/fixtures/delivery/` for 0.152.1 and 0.153.4.
- Modify `packages/adapter-codex/{certification.json,package.json}` and
  `packages/adapter-codex/fixtures/certification-provenance.json`.

- [ ] Run transport phase on the packed implementation while public capability
  remains false. Real installed hooks supply session event metadata; invoke the
  implemented native methods from the installed package. Prove correct B binding,
  idle and busy queue behavior and rejection of A mismatch. Record limited
  transport provenance; do not label this full ACC routing.
- [ ] Use only that observed pass as the initial livePush anchor for the isolated
  candidate. Declare policySource installation-record, activationKinds
  native-service and modes livePush/idleWake/busyQueue. Wire probe, activation,
  bind, refresh and offer methods. Keep replyRoute false. Do not modify the old
  failure fixture or turn its result into pass.
  This intermediate candidate is intentionally not release-certifiable. Final
  audit expectations and its production certification entry are replaced with
  the later actual product evidence before committing capability enablement.
- [ ] Repack. Run **all** product cases below for both exact binary versions.
  Test repeated cold starts of the base A/B isolation and long-idle path three
  times per version; report individual attempts and failures, not a best-of pass.

| ID | Setup/action | Required evidence |
| --- | --- | --- |
| P01 | Daemon A predates install; ordinary receiver B, no policy env | Generated hook uses installed runtime; ACC workspace B, hook cwd B, thread cwd B, actual shell pwd B; no B participant in A |
| P02 | B1 and B2 share B; C1 is in unrelated C; send to B1 | Only B1's exact thread executes the unique marker; B2/C1 have neither marker nor corresponding receipt |
| P03 | Idle B1; send question through installed ACC | recorded then offered; automatic turn without typed user continuation; actual pwd B |
| P04 | Idle beyond original lease by >=30 s (at least 150 s total) | No intervening hook heartbeat; on-demand revalidation, fresh bounded lease, one automatic delivery |
| P05 | Confirm B1 busy in a long shell command, then send | PreToolUse <= queuedAt < Stop <= follow-up UserPromptSubmit; pending queue observed while active; main marker before follow-up marker |
| P06 | B1 explicitly reads exact message then replies | retrieved then acknowledged for original message; one answer with matching inReplyTo, correct sender/recipient; obligation resolved |
| P07 | Retry same ACC client-message-id while pending and after settled receipt | One durable message, one pending submission, no second ACC answer or subsequent normal offer after settled receipt |
| P08 | actionable policy: note, question; then all: note | Note stays queued under actionable, question wakes, note wakes under all; policy read without daemon restart |
| P09 | Active binding, install --delivery off; send before lease expires | Successful durable recording, queued receipt, zero new vendor submission/marker; next hook retires binding; daemon remains running |
| P10 | Restart daemon after enabling, start B with config override selecting Embedded | Correct B workspace; exact ID absent from loaded/list; no live binding/offer; inbox retrieval succeeds |
| P11 | Stop owned daemon, send; install/reinstall while absent | Queue retained, truthful degraded diagnostic, consent retained; no daemon automatically started; later ordinary session can bind once daemon is explicitly restored |
| P12 | New remote thread without --cd; separate diagnostic only | Actual pwd/hook/thread all A; no assertion that terminal B is its workspace; negative control for old wrapper, not a supported ACC launch recipe |
| P13 | Remote absolute --cd B; relative --cd; resume/fork B from C | Explicit modes preserve measured actual cwd; exact-thread checks govern eligibility; ACC adds no arguments |
| P14 | Ordinary /cd C where supported; close/resume/fork sessions | New ID/generation mapped correctly; closed/retired generations cannot receive; 0.152.1 unsupported /cd recorded as a boundary, not a fictitious pass |
| P15 | Sender CODEX_HOME differs from receiver home | Recipient's registered socket is used; sender's daemon queues remain untouched |
| P16 | Wrong server version, unloaded ID, missing socket, malformed metadata | No offer success; queued receipt and sanitized diagnosis; no raw endpoint in CLI/MCP output |
| P17 | Send live, then next normal hook | Already live-offered message is not projected again; uncertified nextTurn does not claim offered; durable inbox works |
| P18 | Upgrade genuine legacy-owned Codex wrapper, then reinstall/uninstall | Unmodified owned wrapper removed; modified wrapper preserved visibly; Claude shim/PATH and daemon retained; repeat operation idempotent |
| P19 | Existing binding then uninstall, send immediately | Removed consent prevents further submissions even before previous lease expires; no unrelated artifacts removed |
| P20 | User-selected paths with spaces/symlinks; repeat base without Git | Canonical receiver identity and ACC workspace agree; hook/skill executable paths work from installed tarball |

- [ ] P14's unsupported subcase is explicitly expected only where observed; it
  cannot replace the close/resume/fork requirements. If a client stops exposing a
  prerequisite, mark that case failed/unobserved and keep that capability disabled.
- [ ] For P16 label malformed/mismatched metadata as controlled fault injection,
  not as naturally observed Codex behavior. Preserve the original valid observation
  and assert the installed sender refuses the mutated endpoint before queue/add.
- [ ] For P18 pack legacy commit `fb148d41c0c890d86e3219e79ed961e78005eb9f`
  (parent of native withdrawal `9accc44`) in a separate temporary worktree. Install
  that real artifact only into the isolated home, then upgrade to the candidate.
  Record both hashes. Do not manufacture the ownership record and call it an
  installed upgrade; synthetic ownership fixtures belong to Task 2's tests.
- [ ] Validate the queue-consumed/ambiguous-ack duplicate boundary separately with
  controlled transport failure. State that transport execution may repeat; do not
  claim exactly-once simply because ACC answer deduplication hid a second turn.
- [ ] Run two actual package mutants, each packed and installed independently:
  M-E2E-1 reinstate the old remote wrapper (P01 must fail cwd/workspace=B);
  M-E2E-2 replace the exact receiver ID with B2's loaded ID (P02 must fail target
  marker/receipt isolation). Restore source and rerun the affected positive cases.
  For the cwd-check mutation, use a controlled inconsistent registration/protocol
  process test; never claim real same-ID cwd drift that was not observed.
- [ ] Check real hook PID ancestry and version matching in P01 on both versions.
  If unresolved, stop enabling the descriptor and revise the narrow adapter/SDK
  contract with observed evidence; never globally remove PID or version gates.
- [ ] Persist closed product evidence and certification only for observed passes.
  Commit feature wiring and real evidence together as
  `feat: enable verified Codex LocalDaemon delivery`.

## Task 7: Final artifact, documentation and review gate

**Files:**

- Modify `packages/adapter-codex/COMPATIBILITY.md`,
  `packages/adapter-codex/fixtures/delivery/README.md`, `docs/CAPABILITIES.md`,
  `docs/ADAPTER_AUTHORING.md`, `packages/adapter-sdk/src/native-vocabulary.mjs`,
  and `packages/adapter-codex/src/adapter.mjs` diagnostics/comments.
- Modify `tests/conformance/{certification-audit.mjs,certification-evidence.test.mjs}`,
  `tests/package-certification.test.mjs`, `scripts/package-certification.mjs` and
  `scripts/verify-package.mjs` where new shipped fixtures/contracts require it.
- Modify `packages/adapter-codex/test/delivery-fallback.test.mjs` to assert current
  reasons instead of universal workspace impossibility.

- [ ] Rewrite the operative fallback explanation: ordinary reachable sessions can
  deliver; embedded, disabled, unsupported or failed identity checks stay durable.
  Preserve historical statements inside dated evidence, with a current correction
  around them. Distinguish actual session cwd from terminal invocation directory.
- [ ] Document recorded consent, runtime reachability, long-idle refresh,
  24-hour presence expiry, already-accepted queue behavior after policy off,
  pending-only transport idempotency and uncaptured platforms. No new guard,
  lifecycle, nextTurn or native replyRoute claim follows from this delivery work.
- [ ] Ensure both positive LocalDaemon product fixtures and the historical remote
  failure fixture ship in the tarball, with resolvable provenance. A passing
  descriptor must not be satisfiable by an empty or missing installed evidence file.
- [ ] Mutate the candidate by removing a referenced product evidence file from
  package files: the installed package verification must fail on missing evidence.
  Restore it and run the final required gates:

  ```sh
  npm ci
  npm run check
  npm test
  npm pack
  node scripts/verify-package.mjs
  git diff --check
  ```

- [ ] Install the final tarball and rerun the complete product matrix if runtime,
  hook, packaging or fixture-loading code changed after capture. If only prose
  changed, rerun P01/P03/P04/P06/P09/P11/P18/P19 plus package fixture validation
  and record the final tarball hash as an artifact-equivalence confirmation.
  Avoid a self-referential tarball hash: capture receipts live outside the tarball;
  shipped evidence names the prior tested runtime build, while the final receipt
  proves the final artifact carries identical runtime bytes and passing evidence.
- [ ] Review the diff against each spec requirement and all mutation receipts.
  Commit `docs: describe verified Codex delivery boundaries`. End with clean
  branch status, commit IDs, gate results, full E2E report and named limitations.
  Record ACC handoff/release claims. No push, merge or public issue reply.

## Definition of done

Ordinary Codex launch retains its real workspace while installed ACC reaches only
its verified current thread; long-idle and confirmed-busy delivery work; consent
revocation and missing/unreachable endpoints remain durable; legacy owned launch
wiring is retired safely. Real captures on both target versions, negative controls,
all designated mutations and installed-package gates substantiate these claims.
Until those conditions hold, Codex native capability remains disabled for release.
