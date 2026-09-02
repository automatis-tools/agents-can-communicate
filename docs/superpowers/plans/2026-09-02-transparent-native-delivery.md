# Transparent Native Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Do not skip the capture checkpoint after Task 4.

**Goal:** Let independently opened Claude Code and Codex sessions receive and answer explicitly addressed ACC messages through vendor-owned transports, while ordinary `claude` and `codex` launches remain unchanged for the user and every transport failure falls back to the durable inbox.

**Architecture:** Installation records a per-client opt-in and may install an ACC-owned shell bootstrap. The bootstrap performs a bounded compatibility check and then replaces itself with the real vendor executable using `exec`; ACC never remains as the parent. A vendor adapter completes a generation-bound runtime handshake, publishes an ephemeral delivery binding, and offers a message only after core has recorded it durably. Static minimum versions admit newer releases only when a current feature probe and session handshake confirm the captured protocol contract.

**Tech Stack:** Node.js 24+, ESM, `node:test`, Node built-ins only, existing ACC workspace packages, vendor-supported local transports (Claude Code Channels and Codex App Server/queue).

**Approved spec:** [`docs/superpowers/specs/2026-09-02-transparent-native-delivery-design.md`](../specs/2026-09-02-transparent-native-delivery-design.md)

---

## Non-negotiable execution rules

- Work in this worktree and branch, never directly on `main`:

  ```bash
  cd /Users/mmykola87/work/automatis-tools/agents-can-communicate/.gitworktrees/transparent-native-delivery-design
  git branch --show-current
  ```

  Expected branch: `transparent-native-delivery-design`.

- Before each task, run `git status --short`. Preserve unrelated user files and changes.
- Use `apply_patch` for edits. Keep production modules and focused tests below 300 lines unless the file has the repository-required cohesion header.
- Add no runtime dependency. Version comparison and protocol framing must use Node built-ins.
- Core must remain vendor-neutral and may not import adapters, Git, or `node:child_process`.
- Detection and `--dry-run` are read-only. Hook and bootstrap paths always fail open.
- Do not set a native capability to `true` until a passing real-client capture exists and the installed artifact exercises the same path.
- A capture is evidence, not a simulation. A fake server can test a driver, but cannot certify the adapter.
- For every new or corrected gate, prove it with a mutation after the green test: alter the guarded behavior, run the exact focused test and observe failure, restore with `apply_patch`, then rerun green. Never use `git checkout --` to restore a file.
- Commit after each task using the commit message listed below. Do not push, merge, tag, or release as part of this plan.
- If either Claude Code or Codex fails the Task 4 checkpoint, stop. Keep the honest failing capture and compatibility note, but do not implement Tasks 5–13.

## Baseline

Run before Task 1:

```bash
env NPM_CONFIG_CACHE=/private/tmp/acc-transparent-native-delivery-npm-cache npm run check
env NPM_CONFIG_CACHE=/private/tmp/acc-transparent-native-delivery-npm-cache npm test
```

Expected baseline as of 2026-09-02: syntax check succeeds; 1,197 tests run, 1,196 pass, 0 fail, 1 skip. A changed count is acceptable only when the suite still runs a non-empty file list and every unexpected difference is explained before editing.

## Resulting component map

| Area | New or principal files | Responsibility |
|---|---|---|
| Capture evidence | `scripts/spikes/delivery-capture.mjs`, vendor spike drivers, adapter `fixtures/delivery/*.json` | Prove ordinary launch, idle/busy behavior, explicit reply, idempotency, and fallback in real clients |
| Adapter contract | `packages/adapter-sdk/src/native-delivery.mjs` | Validate minimums, anchors, denylists, probes, activation plans, handshakes, and offer results |
| Runtime binding | `packages/hook-runner/src/native-binding.mjs`, `packages/core/src/delivery-bindings.mjs` | Correlate a live vendor session with one current ACC session generation |
| Bootstrap | `packages/installer/src/shell-bootstrap.mjs`, `packages/installer/src/bootstrap-runtime.mjs`, `bin/acc-bootstrap.mjs` | Reversible zsh PATH block, per-command shims, compatibility cache, fail-open `exec` |
| Installer UX | installer planner/apply/ownership and CLI install/doctor/status files | Read-only detection, per-client consent, activation lifecycle, truthful state reporting |
| Claude transport | `packages/adapter-claude-code/src/channel.mjs`, `packages/adapter-claude-code/src/native-delivery.mjs`, `bin/acc-claude-channel.mjs` | Vendor-owned Channel endpoint, PID/session handshake, live offer, explicit reply tool |
| Codex transport | `packages/adapter-codex/src/app-server-client.mjs`, `packages/adapter-codex/src/native-delivery.mjs` | App Server daemon/thread handshake and `thread/queue/add` offer |
| Public proof | process/acceptance tests and user docs | Installed-tarball behavior and honest support matrix |

---

## Task 1: Make the capture contract reject half-proofs

**Files:**

- Create: `scripts/spikes/delivery-capture.mjs`
- Modify: `scripts/spikes/json-rpc-peer.mjs`
- Modify: `tests/spikes/capture-contract.test.mjs`
- Modify: `packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.252.json`
- Modify: `packages/adapter-codex/fixtures/delivery/codex-cli-0.152.0.json`

### Step 1: Write the stricter contract tests

Move capture validation out of the generic JSON-RPC helper. Import it from the new module and make the canonical test fixture:

```js
const BASE_CAPTURE = {
  client: "fixture-client",
  version: "1.0.0",
  platform: "darwin-arm64",
  observedAt: "2026-09-02T12:00:00.000Z",
  capability: "native_delivery",
  result: "fail",
  fixture: "fixture-client-1.0.0",
  launchMode: "ordinary-command-with-install-time-bootstrap",
  protocolContract: "fixture-protocol-v1",
  idle: "unobserved",
  busy: "unobserved",
  reply: "unobserved",
  duplicate: "unobserved",
  fallback: "unobserved",
  limitations: ["fixture only"],
};
```

Add tests that prove:

- every listed field is required and unknown fields are rejected;
- stable semantic versions and `darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64` are accepted;
- a passing capture requires `launchMode === "ordinary-command-with-install-time-bootstrap"`;
- a passing capture requires a non-empty, closed `protocolContract` identifier;
- idle must be `offered`;
- busy may be `queued_after_turn` or `rejected_busy`, but never the old `not_interrupted` value;
- reply must be `routed` from an explicit ACC reply action, not inferred from transcript text;
- duplicate must be `same_message_id`;
- fallback must be `queued` after a forced transport failure;
- a failed capture may use `unobserved` for a branch, but must carry at least one limitation.

Use this passing fixture in the test:

```js
validateCapture({
  ...BASE_CAPTURE,
  result: "pass",
  idle: "offered",
  busy: "queued_after_turn",
  reply: "routed",
  duplicate: "same_message_id",
  fallback: "queued",
});
```

### Step 2: Run the test and observe the intended failure

```bash
node --test tests/spikes/capture-contract.test.mjs
```

Expected: failure because `delivery-capture.mjs` does not exist and the old validator accepts `not_interrupted` instead of proving presentation after the current turn.

### Step 3: Implement the closed validator

Export these constants and function from `scripts/spikes/delivery-capture.mjs`:

```js
export const DELIVERY_CAPTURE_FIELDS = Object.freeze([
  "client", "version", "platform", "observedAt", "capability", "result", "fixture",
  "launchMode", "protocolContract", "idle", "busy", "reply", "duplicate", "fallback",
  "limitations",
]);

export const PASSING_DELIVERY_BRANCHES = Object.freeze({
  idle: Object.freeze(["offered"]),
  busy: Object.freeze(["queued_after_turn", "rejected_busy"]),
  reply: Object.freeze(["routed"]),
  duplicate: Object.freeze(["same_message_id"]),
  fallback: Object.freeze(["queued"]),
});

export function validateCapture(value) {
  // closed object, exact identity formats, closed result and branch vocabulary,
  // passing-branch enforcement, frozen clone
}
```

Keep `openJsonRpcPeer()` in `json-rpc-peer.mjs` and re-export `validateCapture` from there temporarily so external spike callers do not break:

```js
export { validateCapture } from "./delivery-capture.mjs";
```

Update both existing failed fixture files with truthful `launchMode` and `protocolContract` values. Do not change their result to `pass`.

### Step 4: Run the focused tests

```bash
node --test tests/spikes/capture-contract.test.mjs tests/spikes/json-rpc-peer.test.mjs
```

Expected: all pass.

### Step 5: Prove the gate with a mutation

Temporarily add `"not_interrupted"` to `PASSING_DELIVERY_BRANCHES.busy`. Run:

```bash
node --test tests/spikes/capture-contract.test.mjs
```

Expected: the test named `a busy pass proves delivery after the current turn or an honest busy rejection` fails. Restore the one-line mutation with `apply_patch` and rerun green.

### Step 6: Commit

```bash
git add scripts/spikes/delivery-capture.mjs scripts/spikes/json-rpc-peer.mjs tests/spikes/capture-contract.test.mjs packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.252.json packages/adapter-codex/fixtures/delivery/codex-cli-0.152.0.json
git commit -m "test: require complete native delivery captures"
```

---

## Task 2: Capture Claude Code Channels in a real ordinary launch

**Hard rule:** This task may produce a passing or failing fixture. It may not change the production adapter capability yet.

**Files:**

- Create: `scripts/spikes/claude-channel-capture-client.mjs`
- Modify: `scripts/spikes/claude-channel.mjs`
- Modify: `tests/spikes/claude-channel.test.mjs`
- Create: `packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.258.json`
- Modify: `packages/adapter-claude-code/fixtures/delivery/README.md`
- Modify: `packages/adapter-claude-code/fixtures/certification-provenance.json`
- Modify: `packages/adapter-claude-code/COMPATIBILITY.md`
- Modify only after a pass: `packages/adapter-claude-code/certification.json`

### Step 1: Write driver tests against a fake Channel peer

Extend the existing Channel tests to cover a session-scoped Unix endpoint and an append-only redacted observation file. The test must assert:

```js
assert.deepEqual(result, {
  accepted: true,
  duplicate: false,
  messageId: "message_capture",
});
assert.equal(observations.filter(item => item.event === "notification_accepted").length, 1);
```

Send the same `messageId` twice and assert that the second response has `duplicate: true` and no second model notification is emitted. Reject envelopes with unknown keys, an invalid session nonce, an endpoint path outside the temporary capture directory, or a body above the protocol limit. Assert that observation records contain event names, ids, and timestamps but never the message body or model output.

### Step 2: Run the test red

```bash
node --test tests/spikes/claude-channel.test.mjs
```

Expected: the existing one-envelope spike has no capture client, deduplication, or observation log.

### Step 3: Implement the disposable capture transport

Keep it under `scripts/spikes/`; do not import it from production. The Channel process must:

1. inherit its parent Claude process and current working directory;
2. create a mode-`0600` Unix socket under a supplied temporary directory;
3. generate a random session nonce with `crypto.randomBytes(32)`;
4. accept closed `{ nonce, messageId, kind, subject, body, inReplyTo }` envelopes;
5. emit a Claude Channel notification using the captured protocol contract;
6. expose explicit `acc_reply` and `acc_ack` tools;
7. record only redacted branch/timestamp evidence;
8. remove its socket on normal close and signals.

`claude-channel-capture-client.mjs` accepts exactly:

```text
--socket <absolute path> --nonce <hex> --message-id <id>
--kind <question|request|answer|decision|handoff|note>
--subject <text> --body <text> [--in-reply-to <id>]
```

It prints one JSON result and exits non-zero on timeout or rejection.

### Step 4: Run the fake-peer tests green

```bash
node --test tests/spikes/claude-channel.test.mjs tests/spikes/capture-contract.test.mjs
```

Expected: all pass.

### Step 5: Capture the real installed client

First record the exact client and machine:

```bash
claude --version
node -p 'process.platform + "-" + process.arch'
```

Expected on the design machine: Claude Code `2.1.258`, `darwin-arm64`. If the version has changed, use the observed stable version in the fixture filename and evidence; never pretend it is 2.1.258.

Use two terminals. In terminal A, set the capture directory printed by `mktemp -d`, then launch the same command a user will retain after installation: `claude` with only the adapter-approved Channel argument injected by a temporary shell bootstrap. The effective vendor invocation must be recorded as:

```text
claude --dangerously-load-development-channels plugin:agents-can-communicate@acc-local
```

Do not hide or auto-answer Claude's experimental Channel warning. In terminal B, use the capture client to run these cases against the exact endpoint for terminal A:

1. **idle:** address a question while Claude is waiting; observe one native notification;
2. **busy:** submit a normal user prompt, send another addressed question while the model is processing, and prove either presentation after that turn (`queued_after_turn`) or an explicit transport rejection (`rejected_busy`);
3. **reply:** have Claude call `acc_reply` for the delivered question and observe the resulting ACC answer record by id;
4. **duplicate:** resend the same message id and observe one model notification total;
5. **fallback:** terminate the Channel child, durably record another addressed message, and observe the ACC receipt remain `queued`.

The capture must not contain prompt or answer text. Generate the fixture from the observation log through `validateCapture()`, with:

```json
{
  "launchMode": "ordinary-command-with-install-time-bootstrap",
  "protocolContract": "claude-code-channel-mcp-v1",
  "idle": "offered",
  "busy": "queued_after_turn",
  "reply": "routed",
  "duplicate": "same_message_id",
  "fallback": "queued"
}
```

Use `rejected_busy` instead if that is what the real client does. If any required branch is not observed, write `result: "fail"`, name the limitation, update `COMPATIBILITY.md`, commit the honest result, and stop this task without touching certification.

### Step 6: Register passing evidence only after a pass

For a pass, append `delivery.livePush` and, only if the native `acc_reply` tool itself performed the route, `delivery.replyRoute` entries to `certification.json`. Each entry must name the exact observed version/platform, the new delivery fixture, the existing package-local provenance file, truthful idle/busy behavior, and the current experimental authority level. Do not delete the older failed capture.

Update `COMPATIBILITY.md` to distinguish:

- first passing capture version/platform;
- minimum research lower bound (`2.1.80`) versus shipped minimum (the first passing capture);
- experimental warning that the user still sees;
- what idle, busy, reply, duplicate, and fallback tests observed;
- platforms not captured.

### Step 7: Validate evidence and prove its gate

```bash
node --test tests/spikes/claude-channel.test.mjs tests/spikes/capture-contract.test.mjs tests/conformance/certification-evidence.test.mjs packages/adapter-sdk/test/certification.test.mjs
```

Mutation: temporarily change the real fixture's `busy` to `not_interrupted`. The capture-contract test must fail. Restore with `apply_patch` and rerun green.

### Step 8: Commit

```bash
git add scripts/spikes/claude-channel.mjs scripts/spikes/claude-channel-capture-client.mjs tests/spikes/claude-channel.test.mjs packages/adapter-claude-code/fixtures/delivery packages/adapter-claude-code/fixtures/certification-provenance.json packages/adapter-claude-code/COMPATIBILITY.md packages/adapter-claude-code/certification.json
git commit -m "test: capture Claude native delivery"
```

---

## Task 3: Capture Codex App Server queueing in a real ordinary launch

**Hard rule:** This task may produce a passing or failing fixture. It may not change the production adapter capability yet.

**Files:**

- Modify: `scripts/spikes/codex-existing-session.mjs`
- Modify: `tests/spikes/codex-existing-session.test.mjs`
- Create: `packages/adapter-codex/fixtures/delivery/codex-cli-0.152.1.json`
- Modify: `packages/adapter-codex/fixtures/delivery/README.md`
- Modify: `packages/adapter-codex/fixtures/certification-provenance.json`
- Modify: `packages/adapter-codex/COMPATIBILITY.md`
- Modify only after a pass: `packages/adapter-codex/certification.json`

### Step 1: Replace the exact-version spike tests with protocol tests

Delete the test that rejects every version except `0.152.0`. Add fake App Server tests for:

- accepting a stable version equal to or newer than a supplied minimum;
- rejecting prerelease versions and versions below the minimum;
- rejecting an initialize response without the captured queue protocol;
- discovering the exact thread id from App Server state/notifications instead of guessing it;
- sending `thread/queue/add` with `{ threadId, message, clientUserMessageId }`;
- preserving the same `clientUserMessageId` on retry;
- treating a duplicate acknowledgement as the same offer;
- returning a closed safe result when the daemon, thread, or method is unavailable;
- never reading assistant transcript content.

The driver-facing result is:

```js
{
  supported: true,
  clientVersion: "0.152.1",
  protocolContract: "codex-app-server-thread-queue-v1",
  modes: ["livePush", "idleWake", "busyQueue"],
  threadId: "thread-native-capture",
}
```

### Step 2: Run the test red

```bash
node --test tests/spikes/codex-existing-session.test.mjs
```

Expected: the current spike hard-codes `0.152.0` and uses the stale `turn/start`/`toolOutput` path rather than `thread/queue/add`.

### Step 3: Implement the disposable queue probe

Use `openJsonRpcPeer()` only for newline JSON-RPC framing. The spike must use official methods and generated schema names observed in the installed client. It must:

```js
await peer.request("initialize", initializeParams);
const queue = await peer.request("thread/queue/add", {
  threadId,
  message: [{ type: "text", text: envelopeText }],
  clientUserMessageId: messageId,
});
```

If the observed schema uses a different field shape, record that exact shape in `protocolContract` and update the fake-peer test before proceeding. Do not call private reverse-engineered endpoints.

### Step 4: Run the fake-peer tests green

```bash
node --test tests/spikes/codex-existing-session.test.mjs tests/spikes/json-rpc-peer.test.mjs
```

Expected: all pass.

### Step 5: Capture the real installed client

Record:

```bash
codex --version
codex app-server daemon version
node -p 'process.platform + "-" + process.arch'
```

Expected on the design machine: Codex `0.152.1`, `darwin-arm64`. If the daemon is absent, record that fact, run the vendor-supported `codex app-server daemon bootstrap` only for this explicit capture, and record that ACC created it so the supported teardown can be exercised later. Do not kill or replace a pre-existing daemon.

Launch the user-facing `codex` command through a temporary bootstrap whose only modification is the vendor-supported remote/daemon attachment captured from `codex --help` and App Server help. Then prove:

1. **idle:** `thread/queue/add` wakes/presents an addressed question to the exact idle thread;
2. **busy:** a queue addition made during an active turn is presented after that turn, or the method returns an explicit busy rejection;
3. **reply:** Codex handles the question and invokes the existing ACC reply surface, producing an answer record linked by `inReplyTo`;
4. **duplicate:** retrying the same `clientUserMessageId` does not create two user messages;
5. **fallback:** with the daemon connection deliberately unavailable, the ACC record and receipt remain durable and queued.

The passing fixture uses:

```json
{
  "launchMode": "ordinary-command-with-install-time-bootstrap",
  "protocolContract": "codex-app-server-thread-queue-v1",
  "idle": "offered",
  "busy": "queued_after_turn",
  "reply": "routed",
  "duplicate": "same_message_id",
  "fallback": "queued"
}
```

If any branch is not observed, record `result: "fail"`, update `COMPATIBILITY.md`, commit that evidence, and do not add passing certification.

### Step 6: Register passing evidence only after a pass

Append only `delivery.livePush` evidence unless Codex exposes a native reply callback implemented by the adapter; using the existing ACC skill/CLI to reply proves the product loop but does not by itself prove `delivery.replyRoute`.

Document the passing version/platform, daemon lifecycle, exact protocol revision/features, queue behavior, fallback, and uncaptured platforms. Retain the older `0.152.0` failed fixture.

### Step 7: Validate evidence and prove its gate

```bash
node --test tests/spikes/codex-existing-session.test.mjs tests/spikes/capture-contract.test.mjs tests/conformance/certification-evidence.test.mjs packages/adapter-sdk/test/certification.test.mjs
```

Mutation: temporarily make the driver use a random `clientUserMessageId` on retry. The duplicate test must fail. Restore with `apply_patch` and rerun green.

### Step 8: Commit

```bash
git add scripts/spikes/codex-existing-session.mjs tests/spikes/codex-existing-session.test.mjs packages/adapter-codex/fixtures/delivery packages/adapter-codex/fixtures/certification-provenance.json packages/adapter-codex/COMPATIBILITY.md packages/adapter-codex/certification.json
git commit -m "test: capture Codex native delivery"
```

---

## Task 4: Capture Grok honestly and enforce the feasibility checkpoint

**Files:**

- Create: `packages/adapter-grok/fixtures/delivery/grok-1.0.13.json`
- Create: `packages/adapter-grok/fixtures/delivery/README.md`
- Create: `packages/adapter-grok/fixtures/certification-provenance.json` using the same closed provenance schema as the other adapters
- Modify: `packages/adapter-grok/COMPATIBILITY.md`
- Modify only after a pass: `packages/adapter-grok/certification.json`
- Create: `scripts/spikes/check-native-captures.mjs`
- Create: `tests/spikes/native-capture-checkpoint.test.mjs`

### Step 1: Verify only public, vendor-supported surfaces

Record `grok --version`, `grok --help`, the documented `[cli] use_leader = true` behavior, and the public `grok agent stdio`/ACP help. Launch two ordinary Grok clients with leader mode enabled and inspect whether the supported interface exposes an exact current-session identity and an addressed message injection path. If the installed stable version is no longer `1.0.13`, use the observed version in the fixture filename and fields.

Do not use a private socket, scrape a terminal, read a transcript, change normal launch into ACC-owned ACP launch, or infer support merely because two clients share a leader PTY.

### Step 2: Write the capture

If the public surface proves every capture branch, write a passing fixture with the observed protocol contract and add certification. Otherwise construct the expected honest result in the capture script so the timestamp is measured rather than hand-written:

```js
validateCapture({
  "client": "grok",
  "version": "1.0.13",
  "platform": "darwin-arm64",
  "observedAt": new Date().toISOString(),
  "capability": "native_delivery",
  "result": "fail",
  "fixture": "grok-1.0.13",
  "launchMode": "ordinary-command-with-install-time-bootstrap",
  "protocolContract": "grok-leader-public-surface-v1",
  "idle": "unobserved",
  "busy": "unobserved",
  "reply": "unobserved",
  "duplicate": "unobserved",
  "fallback": "queued",
  "limitations": [
    "The public leader/ACP surface did not expose a proven addressed injection route into an independently opened ordinary TUI session."
  ]
});
```

Replace the timestamp and any observed branches with measured facts. A failing Grok capture does not block Claude/Codex work.

### Step 3: Automate the stop/go checkpoint

Write a small script that accepts repeated closed arguments:

```text
--required claude_code=<absolute fixture path>
--required codex=<absolute fixture path>
--optional grok=<absolute fixture path>
```

It must read each JSON file through `validateCapture()`, print the decision table without message bodies or limitations, and exit non-zero when any required capture is absent, invalid, or not `pass`. An optional failure is printed but does not affect exit status. Tests use temporary pass/fail fixtures and prove Claude and Codex are both required.

### Step 4: Validate and commit

```bash
node --test tests/spikes/capture-contract.test.mjs tests/spikes/native-capture-checkpoint.test.mjs tests/conformance/certification-evidence.test.mjs
git add packages/adapter-grok/fixtures packages/adapter-grok/COMPATIBILITY.md packages/adapter-grok/certification.json scripts/spikes/check-native-captures.mjs tests/spikes/native-capture-checkpoint.test.mjs
git commit -m "test: record Grok native delivery compatibility"
```

### Step 5: Prove the checkpoint with a mutation

Temporarily remove Codex from the script's required-failure calculation. Run:

```bash
node --test tests/spikes/native-capture-checkpoint.test.mjs
```

Expected: `Codex failure blocks production implementation` fails. Restore and rerun green.

### Step 6: Stop/go checkpoint

Read the current Claude and Codex delivery fixtures through `validateCapture()` and print only this decision table:

```text
Claude Code  pass|fail  <version>  <platform>  <protocolContract>
Codex        pass|fail  <version>  <platform>  <protocolContract>
Grok         pass|fail  <version>  <platform>  <protocolContract>
```

Proceed to Task 5 only when both Claude Code and Codex are `pass`. Grok is conditional. If Claude or Codex is `fail`, stop implementation and report which exact required branch or supported vendor primitive is absent. Do not rationalize a half-working transport into a capability.

---

## Task 5: Add the minimum-plus-probe native-delivery contract

**Files:**

- Create: `packages/adapter-sdk/src/native-delivery.mjs`
- Create: `packages/adapter-sdk/test/native-delivery.test.mjs`
- Modify: `packages/adapter-sdk/src/capabilities.mjs`
- Modify: `packages/adapter-sdk/src/index.mjs`
- Modify: `packages/adapter-sdk/test/capabilities.test.mjs`
- Modify: `tests/conformance/adapter-contract.mjs`
- Modify: `tests/conformance/example-adapter.test.mjs`
- Modify: `docs/ADAPTER_AUTHORING.md`

### Step 1: Write the contract tests

Add fixture adapters that exercise the complete static contract:

```js
const nativeDelivery = {
  minimumByPlatform: { "darwin-arm64": "2.1.258" },
  anchors: [{
    platform: "darwin-arm64",
    version: "2.1.258",
    protocolContract: "fixture-native-v1",
  }],
  knownBad: [{
    from: "2.1.300",
    to: "2.1.302",
    reasonCode: "known_bad_version",
  }],
  activationKinds: ["shell-bootstrap"],
};
```

Test these closed outcomes from `evaluateNativeEligibility()`:

```js
{
  eligible: true,
  reasonCode: null,
  minimumVersion: "2.1.258",
  protocolContract: "fixture-native-v1",
  modes: ["livePush", "idleWake"],
}
```

Cover:

- exact minimum passes;
- a much newer stable version passes without a maximum version entry;
- numeric semantic comparison makes `2.10.0` newer than `2.9.99`;
- a version below minimum returns `below_minimum_version`;
- a prerelease returns `prerelease_not_captured` even when numerically newer;
- a known-bad exact version or inclusive interval returns `known_bad_version`;
- an uncaptured platform returns `platform_not_captured`;
- unsupported, timed-out, mismatched-version, or wrong-protocol probes fail closed for live delivery;
- the returned modes are the intersection of probe modes and the closed SDK mode vocabulary;
- the result and manifest are deeply frozen;
- every unknown manifest/probe key is rejected;
- each anchor must correspond to passing `delivery.livePush` certification with the same client/version/platform;
- every `activationKinds` entry is one of `shell-bootstrap`, `native-config`, or `native-service`;
- a regular adapter without `nativeDelivery` continues to validate with live delivery off.

### Step 2: Run the tests red

```bash
node --test packages/adapter-sdk/test/native-delivery.test.mjs packages/adapter-sdk/test/capabilities.test.mjs tests/conformance/example-adapter.test.mjs
```

Expected: the new module and contract do not exist.

### Step 3: Implement stable version comparison and closed validation

Export this public surface from `native-delivery.mjs`:

```js
export const NATIVE_BINDING_MODES = Object.freeze([
  "livePush", "idleWake", "busyQueue", "replyRoute",
]);

export const NATIVE_ACTIVATION_KINDS = Object.freeze([
  "shell-bootstrap", "native-config", "native-service",
]);

export function validateNativeDeliveryContract(value, { certification, client }) {
  // Return a deeply frozen normalized contract or throw AccError(EXIT.USAGE).
}

export function compareStableVersions(left, right) {
  // Compare three numeric components; allow +build metadata; reject prereleases.
}

export function evaluateNativeEligibility(adapter, {
  clientVersion,
  platform,
  probe,
}) {
  // Return the closed result tested above. Never execute a probe here.
}

export function validateNativeHandshake(adapter, {
  clientVersion,
  platform,
  handshake,
}) {
  // Recheck minimum, platform anchor, denylist, protocol, and modes for the
  // current session. The launch-time executable fingerprint stays probe-only.
}
```

Use a local parser with this accepted shape:

```js
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;
```

Do not use lexical comparison and do not add `semver`.

The read-only adapter probe result has this exact closed shape:

```js
{
  supported: true,
  clientVersion: "2.1.258",
  protocolContract: "fixture-native-v1",
  executableFingerprint: `sha256:${"a".repeat(64)}`,
  modes: ["livePush", "idleWake"],
  reasonCode: null,
}
```

An unsupported result uses `supported: false`, an empty `modes` array, and one of the closed reason codes documented in the module; it must still identify the observed version and executable fingerprint when available. Diagnostics may be returned separately by adapter detection but are not decision input.

### Step 4: Wire the contract into `defineAdapter()`

In `capabilities.mjs`:

- validate `manifest.nativeDelivery` only when present;
- require `probeNativeDelivery()`, `planNativeActivation()`, and `bindNativeSession()` when the static contract is present;
- retain the existing `offerMessage()` and certification requirements for `delivery.livePush`;
- require `routeReply()` only when `delivery.replyRoute` is true;
- include frozen `nativeDelivery` in the returned adapter.

Do not change `effectiveCapabilities()`: exact-version certification remains authoritative for hooks, guards, context injection, and next-turn delivery. `evaluateNativeEligibility()` is the separate, explicit rule used only for native live delivery.

Export the new constants and functions from `packages/adapter-sdk/src/index.mjs`.

### Step 5: Update conformance and authoring docs

The conformance adapter must demonstrate both a valid native adapter and a regular adapter with no native contract. `docs/ADAPTER_AUTHORING.md` must state:

- a minimum is the first passing capture, not a guessed first vendor release;
- there is intentionally no maximum;
- newer stable releases must pass a current feature probe and session handshake;
- prereleases require their own passing capture;
- exact-version certification still governs every non-native capability;
- methods return closed facts and never put vendor data into core.

### Step 6: Run focused tests

```bash
node --test packages/adapter-sdk/test/native-delivery.test.mjs packages/adapter-sdk/test/capabilities.test.mjs tests/conformance/example-adapter.test.mjs tests/conformance/certification-evidence.test.mjs
```

Expected: all pass.

### Step 7: Prove the no-maximum gate with a mutation

Temporarily change eligibility to require `clientVersion === minimumVersion`. Run:

```bash
node --test packages/adapter-sdk/test/native-delivery.test.mjs
```

Expected: `a newer stable client is admitted by the same captured protocol` fails. Restore with `apply_patch` and rerun green.

### Step 8: Commit

```bash
git add packages/adapter-sdk tests/conformance docs/ADAPTER_AUTHORING.md
git commit -m "feat: define native delivery compatibility contract"
```

---

## Task 6: Publish only current, handshake-proven runtime bindings

**Files:**

- Modify: `packages/protocol/src/schema.mjs`
- Modify: `packages/protocol/test/schema.test.mjs`
- Modify: `packages/core/src/delivery-bindings.mjs`
- Modify: `packages/core/src/service.mjs`
- Modify: `packages/core/test/delivery-bindings.test.mjs`
- Create: `packages/hook-runner/src/native-binding.mjs`
- Create: `packages/hook-runner/test/native-binding.test.mjs`
- Modify: `packages/hook-runner/src/runner.mjs`
- Modify: `packages/hook-runner/test/runner.test.mjs`
- Modify: `packages/adapter-sdk/src/session-binding.mjs`
- Modify: `packages/adapter-sdk/test/session-binding.test.mjs`
- Modify: `tests/process/delivery-bindings.test.mjs`

### Step 1: Write protocol and core tests

Extend `deliveryBinding.availableModes` to accept:

```js
["nextTurn", "livePush", "idleWake", "busyQueue", "replyRoute"]
```

Add tests that reject unknown modes and duplicate modes. Add `clearDeliveryBinding({ sessionId, generation })` tests proving:

- the current generation may remove its binding;
- a stale generation cannot remove a successor's binding;
- closing a session removes its own current binding;
- an absent binding is an idempotent no-op;
- a failed re-handshake cannot leave an older binding reachable.

### Step 2: Run protocol/core tests red

```bash
node --test packages/protocol/test/schema.test.mjs packages/core/test/delivery-bindings.test.mjs
```

Expected: new modes and clear method are absent.

### Step 3: Implement generation-safe clearing

Add to `createDeliveryBindingService()`:

```js
async function clearDeliveryBinding({ sessionId, generation }) {
  await store.ephemeral.update("deliveryBinding", sessionId, current => {
    if (current === null || current === undefined) return null;
    if (current.generation !== generation) throw conflict(sessionId);
    return null;
  });
}
```

If the filesystem store's update contract does not use `null` for deletion, use `get()` plus a generation check and `delete()`, then add a race test showing a successor cannot be deleted. Export the method through `service.mjs`. Compose `closeSession` in `createCoordinationService()` as a wrapper that closes the session, then clears the delivery binding for the same input generation; expose that wrapper after the spread of ordinary session methods. Do not make `sessions.mjs` depend on delivery bindings and do not add adapter knowledge to core.

### Step 4: Write hook-handshake tests

Test a helper with a fake adapter and fake service. The public helper contract is:

```js
await establishNativeBinding({
  adapter,
  event,
  hookBinding: { accSessionId, generation, clientPid },
  clientVersion,
  platform,
  livePolicy,
  service,
  runtimeDir,
  clock,
  timeoutMs: 750,
});
```

Cover:

- policy `off` clears a current native binding and does not handshake;
- missing, malformed, or externally supplied policy values outside `off|actionable|all` are treated as `off`;
- no native contract is a no-op;
- handshake success publishes only the adapter-provided modes, opaque endpoint reference, and bounded lease;
- the helper, not the adapter, supplies adapter id, client version, ACC session id, and generation;
- an endpoint reference is never printed in the result or diagnostic;
- timeout, throw, unsupported response, mismatched version, and stale generation clear the old binding and return a closed degraded result;
- the hook event still succeeds after each failure;
- SessionStart and SessionResume attempt a handshake after ACC session attachment;
- later safe hook events may renew/retry a binding, so a Claude Channel that becomes ready just after SessionStart is not permanently missed.

The adapter handshake result is closed:

```js
{
  supported: true,
  clientVersion: "2.1.258",
  protocolContract: "claude-code-channel-mcp-v1",
  modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
  opaqueEndpointRef: "adapter-owned-endpoint-id",
  leaseUntil: "2026-09-02T12:01:00.000Z",
  reasonCode: null,
}
```

### Step 5: Run hook tests red

```bash
node --test packages/hook-runner/test/native-binding.test.mjs packages/hook-runner/test/runner.test.mjs
```

Expected: helper and runner integration are absent.

### Step 6: Implement the bounded fail-open helper

Create `native-binding.mjs` with:

```js
export async function establishNativeBinding(input) {
  // clear any current binding for this exact generation;
  // race adapter.bindNativeSession() against timeoutMs;
  // validate the current session through validateNativeHandshake();
  // publish a sanitized binding on success;
  // return { state: "active"|"off"|"degraded"|"unsupported", reasonCode };
  // catch all adapter/transport errors after best-effort clear.
}
```

Use a local timeout promise and always clear its timer. Do not abort the client or throw from the hook path. Validate `leaseUntil` is in the future and no farther than twice the session heartbeat cadence; clamp or reject an adapter's longer lease.

Extend the existing hook session binding with optional `clientPid`, validate it as a positive integer, and refresh it during SessionStart when the process-table resolver finds the vendor process. Old bindings without it remain valid but cannot publish a native endpoint until a fresh SessionStart resolves the process. This is a safe restart requirement, not a migration.

Derive `livePolicy` only from the inherited `ACC_NATIVE_DELIVERY_POLICY` set by a successful owned shell bootstrap. Missing or invalid values become `off`. Call the helper from `runner.mjs` after start/resume attachment and from the existing before-turn/safe-point paths as a bounded retry. Do not call it on every read/write guard event.

### Step 7: Run focused tests and boundaries

```bash
node --test packages/protocol/test/schema.test.mjs packages/core/test/delivery-bindings.test.mjs packages/adapter-sdk/test/session-binding.test.mjs packages/hook-runner/test/native-binding.test.mjs packages/hook-runner/test/runner.test.mjs tests/process/delivery-bindings.test.mjs tests/package-boundaries.test.mjs
```

Expected: all pass; core has no vendor or child-process import.

### Step 8: Prove stale-binding removal with a mutation

Temporarily remove the best-effort clear before a failed handshake. Run:

```bash
node --test packages/hook-runner/test/native-binding.test.mjs
```

Expected: `a failed re-handshake cannot leave a stale live endpoint` fails. Restore and rerun green.

### Step 9: Commit

```bash
git add packages/protocol packages/core packages/hook-runner tests/process/delivery-bindings.test.mjs
git commit -m "feat: bind native transports to live session generations"
```

---

## Task 7: Route actionable messages without re-imposing an exact version ceiling

**Files:**

- Modify: `packages/delivery-router/src/router.mjs`
- Modify: `packages/delivery-router/test/router.test.mjs`
- Modify: `packages/delivery-router/test/router-receipt-state.test.mjs`
- Modify: `tests/process/offer-after-write.test.mjs`
- Modify: `tests/process/message-delivery.test.mjs`
- Modify: `tests/process/unknown-recipient.test.mjs`

### Step 1: Write router policy and identity tests

Add test messages for all kinds and assert:

| Policy | question | request | answer | decision | handoff | note | room message |
|---|---:|---:|---:|---:|---:|---:|---:|
| `off` | queued | queued | queued | queued | queued | queued | no offer |
| `actionable` | offered | offered | offered | offered | offered | queued | no offer |
| `all` | offered | offered | offered | offered | offered | offered | no offer |

Also prove:

- a newer binding version is accepted after it has already passed the runtime handshake; the router does not call `effectiveCapabilities()` again;
- adapter id, session id, generation, client version, and endpoint ref must all match one current live binding;
- zero live sessions, multiple live sessions, multiple bindings, expired leases, and unknown adapters fall back durably;
- an adapter exception or rejection cannot change the durable record or queued receipt;
- `accepted: true` is not enough when the adapter reports a client version different from the binding;
- only `accepted: true` commits the `offered` receipt/event;
- endpoint refs and thrown error text never escape through CLI results or durable events;
- a repeated offer for an already offered/retrieved/acknowledged receipt does not call the adapter again.

### Step 2: Run tests red

```bash
node --test packages/delivery-router/test/router.test.mjs packages/delivery-router/test/router-receipt-state.test.mjs tests/process/offer-after-write.test.mjs
```

Expected: `answer` and `decision` are not actionable and the exact-version certification filter rejects a newer binding.

### Step 3: Implement the router change

Replace the policy predicate with:

```js
const ACTIONABLE = new Set(["question", "request", "answer", "decision", "handoff"]);
const permits = (policy, kind) => policy === "all"
  || (policy === "actionable" && ACTIONABLE.has(kind));
```

Remove the router's import and call to `effectiveCapabilities()`. A reachable binding is eligible only when:

```js
adapter !== undefined
  && adapter.capabilities.delivery.livePush === true
  && adapter.nativeDelivery !== undefined
  && binding.availableModes.includes("livePush")
```

Compatibility was established at bootstrap and proven again during the generation-bound handshake; the router validates binding identity and the adapter's offer response rather than introducing a third, exact-version rule. Keep record-first behavior unchanged.

Map adapter responses to the existing safe error vocabulary. If the real captures require a distinct safe `session_handshake_failed`, add it to the closed set and docs; do not persist vendor error strings.

### Step 4: Run focused tests

```bash
node --test packages/delivery-router/test/router.test.mjs packages/delivery-router/test/router-receipt-state.test.mjs tests/process/offer-after-write.test.mjs tests/process/message-delivery.test.mjs tests/process/unknown-recipient.test.mjs
```

Expected: all pass.

### Step 5: Prove record-first with a mutation

Temporarily invoke `adapter.offerMessage()` before the test service's durable `sendMessage()` resolves. Run:

```bash
node --test tests/process/offer-after-write.test.mjs
```

Expected: the existing gate fails. Restore with `apply_patch` and rerun green.

### Step 6: Prove answers are live with a mutation

Temporarily remove `answer` from `ACTIONABLE`. Run:

```bash
node --test packages/delivery-router/test/router.test.mjs
```

Expected: the actionable-policy matrix fails. Restore and rerun green.

### Step 7: Commit

```bash
git add packages/delivery-router tests/process/offer-after-write.test.mjs tests/process/message-delivery.test.mjs tests/process/unknown-recipient.test.mjs
git commit -m "feat: route complete actionable conversations live"
```

---

## Task 8: Build the reversible zsh bootstrap and runtime probe cache

**Files:**

- Create: `packages/installer/src/bootstrap-runtime.mjs`
- Create: `packages/installer/src/shell-bootstrap.mjs`
- Create: `packages/installer/test/bootstrap-runtime.test.mjs`
- Create: `packages/installer/test/shell-bootstrap.test.mjs`
- Modify: `packages/installer/src/index.mjs`
- Create: `bin/acc-bootstrap.mjs`
- Create: `tests/process/native-shell-bootstrap.test.mjs`
- Modify: `package.json`

### Step 1: Write bootstrap runtime tests

Test `checkNativeBootstrap()` with fake adapters, executables, clock, and activation storage:

```js
await checkNativeBootstrap({
  adapter,
  realExecutable,
  platform: "darwin-arm64",
  dataHome,
  timeoutMs: 750,
  clock,
});
```

Cover:

- minimum version plus matching feature probe returns `{ supported: true }`;
- a newer stable version also returns true;
- old, prerelease, known-bad, wrong-protocol, timed-out, throwing, and malformed probes return false without throwing;
- cache key includes adapter id, resolved executable path, symlink target, version, size, mtime, and executable fingerprint;
- unchanged executable reuses the bounded cache;
- replacing or upgrading the executable invalidates the cache;
- a cached failure has a short bounded lifetime and cannot permanently disable a repaired client;
- the cache stores only closed probe facts and never command output or message content.

Use an atomic ACC-data-home cache file and mode `0600`. Name it under the installer-owned activation directory, never under a repository.

### Step 2: Write shell-rendering and process tests

The generic entry is:

```js
{
  adapterId: "claude_code",
  command: "claude",
  realExecutable: "/absolute/vendor/bin/claude",
  prefixArgs: [
    "--dangerously-load-development-channels",
    "plugin:agents-can-communicate@acc-local",
  ],
  livePolicy: "actionable",
}
```

Test that the generated command shim:

- uses only installer-escaped literals;
- if `ACC_BYPASS=1`, immediately `exec`s the real executable with exactly the user's arguments;
- otherwise runs the pinned Node executable and `bin/acc-bootstrap.mjs` as a bounded check;
- on check exit 0, exports `ACC_NATIVE_DELIVERY_POLICY` from the owned plan and `exec`s the real executable with fixed prefix args followed by user args;
- on any non-zero exit, missing Node, damaged ACC file, timeout, or signal, `exec`s the real executable with only user args;
- bypass/fallback launches explicitly unset the reserved `ACC_NATIVE_DELIVERY_POLICY`, so hooks cannot mistake an unmodified launch for an activated transport;
- never uses `eval` or re-parses user arguments;
- preserves spaces, quotes, glob characters, and empty arguments byte-for-byte;
- replaces the shim process: a fake vendor prints its PID and the test asserts it equals the originally spawned shim PID;
- resolves the real executable before prepending the shim directory and never resolves itself recursively.

Test a marked zsh block with exact sentinels:

```text
# >>> agents-can-communicate native delivery >>>
export PATH="<ACC-owned absolute shim directory>:$PATH"
# <<< agents-can-communicate native delivery <<<
```

The editor must preserve all user bytes outside the block, refuse a modified block on uninstall, be idempotent, and remove the block only when the last ACC shim is gone.

### Step 3: Run tests red

```bash
node --test packages/installer/test/bootstrap-runtime.test.mjs packages/installer/test/shell-bootstrap.test.mjs tests/process/native-shell-bootstrap.test.mjs
```

Expected: modules and internal executable do not exist.

### Step 4: Implement the bootstrap runtime

Export:

```js
export async function checkNativeBootstrap({
  adapter, realExecutable, platform, dataHome, timeoutMs, clock,
}) {
  // resolve/stat executable, obtain version, load keyed cache, run bounded
  // adapter.probeNativeDelivery(), evaluateNativeEligibility(), atomically cache,
  // return { supported, reasonCode } without throwing.
}
```

The probe receives the resolved executable and must invoke only read-only vendor help/version/protocol discovery. The generic runtime never branches on adapter id.

`bin/acc-bootstrap.mjs` parses closed options:

```text
--adapter <portable id> --real-executable <absolute path> --data-home <absolute path>
```

It composes the shipped adapter registry, calls `checkNativeBootstrap()`, and exits 0 only for supported. It writes no stdout. Stderr is empty for expected fallback states and contains only a safe one-line diagnostic under an explicit debug environment variable.

Add the internal bin file to the package `files` payload through the existing `bin/` directory. Do not add it to the public `bin` command map.

### Step 5: Implement owned zsh/shim lifecycle

Export:

```js
export function planShellBootstrap({ shell, rcFile, shimDir, entries }) {}
export async function installShellBootstrap({ plan, io }) {}
export async function uninstallShellBootstrap({ ownership, io }) {}
export function renderCommandShim({ node, bootstrap, dataHome, entry }) {}
```

Support zsh on macOS first. Detection on unsupported shells returns an ineligible activation reason; it never silently edits a different shell file. Store per-file content hashes and exact generated bytes in the installer ownership record so uninstall removes only matching ACC bytes. Mode the shim directory `0700` and shims `0700`.

### Step 6: Run tests and package verification

```bash
node --test packages/installer/test/bootstrap-runtime.test.mjs packages/installer/test/shell-bootstrap.test.mjs tests/process/native-shell-bootstrap.test.mjs
npm pack
node scripts/verify-package.mjs
```

Expected: all pass; the tarball contains `bin/acc-bootstrap.mjs`, installer modules, and no absolute local path.

### Step 7: Prove fail-open with a mutation

Temporarily make a failed bootstrap check execute the prefixed vendor arguments. Run:

```bash
node --test tests/process/native-shell-bootstrap.test.mjs
```

Expected: `a failed probe launches the untouched vendor command` fails. Restore and rerun green.

### Step 8: Commit

```bash
git add packages/installer bin/acc-bootstrap.mjs tests/process/native-shell-bootstrap.test.mjs package.json
git commit -m "feat: add fail-open native shell bootstrap"
```

---

## Task 9: Add per-client install consent and owned activation lifecycle

**Files:**

- Modify: `packages/installer/src/detect.mjs`
- Modify: `packages/installer/src/plan.mjs`
- Modify: `packages/installer/src/apply.mjs`
- Modify: `packages/installer/src/ownership.mjs`
- Modify: `packages/installer/test/detect.test.mjs`
- Modify: `packages/installer/test/install.test.mjs`
- Modify: `packages/installer/test/ownership.test.mjs`
- Modify: `packages/installer/test/uninstall-recovery.test.mjs`
- Modify: `packages/installer/test/no-silent-downgrade.test.mjs`
- Modify: `packages/cli/src/args.mjs`
- Modify: `packages/cli/src/install-command.mjs`
- Modify: `packages/cli/src/main.mjs`
- Modify: `packages/cli/src/confirm.mjs`
- Modify: `packages/cli/test/args.test.mjs`
- Modify: `packages/cli/test/install-command.test.mjs`
- Modify: `tests/process/install-targets.test.mjs`
- Modify: `tests/process/an-upgrade-leaves-no-old-copy.test.mjs`
- Modify: `tests/security/installer.test.mjs`
- Modify: `tests/security/restore-every-client.test.mjs`

### Step 1: Write per-adapter planning tests

Change the planner input from one global implicit value to an explicit map:

```js
planInstallation({
  adapters,
  detected,
  context,
  action: "install",
  deliveryByAdapter: {
    claude_code: "actionable",
    codex: "off",
  },
});
```

Keep `off|actionable|all` as the only policy values. Test:

- missing map entries mean `off`;
- a policy for an unselected or unknown adapter is a usage error;
- one eligible adapter may be actionable while another is off;
- an omitted policy preserves a previously consented native activation during an upgrade, but never creates one for an old record whose native fields are absent;
- explicit `off` removes that adapter's native shim/config activation while preserving ordinary ACC hooks, skills, and durable delivery;
- changing `actionable` to `all` atomically regenerates only the owned policy-bearing shim;
- an unsupported, below-minimum, known-bad, prerelease, wrong-platform, or failed-probe adapter cannot receive a native activation operation;
- ordinary hook/plugin installation still proceeds when live activation is ineligible;
- detection invokes version/help/protocol probes only and never a native service mutation;
- dry-run computes the exact shell/config/service plan but executes nothing;
- install operations describe every affected rc file, shim, native config artifact, and native service state change;
- uninstall is driven by ownership records even when a client disappeared from PATH;
- an ownership record without native fields (every existing 0.2 install) reads as live policy `off` and triggers no migration.

### Step 2: Write CLI interaction tests

Make `--adapter` repeatable for both install and uninstall. Add tests for these exact behaviors:

```text
acc install --adapter claude_code --adapter codex --delivery actionable
acc install --delivery off
acc install --dry-run
```

- explicit delivery applies uniformly to selected eligible adapters and never prompts;
- non-interactive stdin or stdout plus omitted delivery installs with `off` and never prompts;
- `--dry-run` plus omitted delivery previews `off`, never prompts, and prints that interactive choices were not made;
- interactive stdin and stdout plus omitted delivery perform all read-only detection first, then ask one default-No question per eligible adapter;
- each question names client, mechanism, and affected rc/config/service;
- each question says activation applies to newly launched sessions and that a newly written PATH block needs a new/reloaded shell;
- answering Yes for Claude and No for Codex produces different map entries;
- an adapter with a recorded prior opt-in keeps that explicit policy on upgrade without being re-enabled from inference; `--delivery off` is the deliberate disable path;
- ineligible Gemini/Kimi/Grok are reported but not asked;
- EOF and blank input mean No;
- no prompt runs before detection completes successfully.

Inject TTY facts and confirmation through runtime ports; tests must not replace global stdin/stdout:

```js
{
  input,
  output,
  isInteractive: () => input.isTTY === true && output.isTTY === true,
  confirm: (question, io) => askConfirmation(question, io),
}
```

### Step 3: Run planner/CLI tests red

```bash
node --test packages/installer/test/detect.test.mjs packages/installer/test/install.test.mjs packages/installer/test/ownership.test.mjs packages/cli/test/args.test.mjs packages/cli/test/install-command.test.mjs
```

Expected: the planner accepts one global delivery value, install adapter is single-valued, and no per-client prompt exists.

### Step 4: Validate closed activation plans in the SDK

Before wiring apply, extend Task 5's module and tests with:

```js
export function validateNativeActivationPlan(value) {
  // Deeply freeze one closed plan; reject unknown keys and shell strings.
}
```

The adapter method returns:

```js
{
  eligible: true,
  reasonCode: null,
  mechanisms: [
    {
      kind: "shell-bootstrap",
      command: "claude",
      realExecutable: "/absolute/vendor/bin/claude",
      prefixArgs: ["--captured-vendor-flag", "captured-value"],
    },
    {
      kind: "native-config",
      artifactIds: ["adapter-owned-config-block"],
    },
    {
      kind: "native-service",
      serviceId: "vendor-daemon",
      preExisting: false,
      applyCommand: {
        executable: "/absolute/vendor/bin/client",
        args: ["vendor", "bootstrap"],
      },
      teardownCommand: null,
    },
  ],
}
```

An adapter returns only the mechanisms it needs. Commands are executable plus argument arrays, never shell source. `native-config` is applied by the adapter's existing install method; the generic installer records its declared artifact ids. `native-service` status is determined during read-only detection, and apply is the only phase allowed to execute `applyCommand`.

### Step 5: Implement detection, planning, apply, and ownership

Detection adds a closed `nativeDelivery` report per adapter:

```js
{
  state: "eligible" | "unsupported" | "degraded",
  reasonCode: null | "below_minimum_version" | "prerelease_not_captured"
    | "known_bad_version" | "platform_not_captured" | "feature_probe_failed"
    | "protocol_mismatch" | "unsupported_shell",
  probe,
  activationPlan,
}
```

Apply mechanisms in deterministic order: adapter-owned native config/plugin wiring, vendor native-service command, then generic shell bootstrap. If a later mechanism fails, best-effort roll back only bytes/services written by this operation and report the partial state; never remove a pre-existing service or user-modified file.

Extend the existing ownership schema backward-compatibly with optional:

```js
nativeActivation: {
  livePolicy: "off" | "actionable" | "all",
  protocolContract: "captured-protocol-v1",
  mechanisms: [
    {
      kind: "shell-bootstrap",
      ownedFiles: [{ path: "/absolute/path", sha256: "a".repeat(64) }],
    },
    {
      kind: "native-service",
      serviceId: "vendor-daemon",
      createdByAcc: true,
      teardownCommand: null,
    },
  ],
}
```

Do not bump or rewrite an existing record solely to add absent fields. Uninstall removes a native service only when `createdByAcc` is true and a vendor-supported teardown command was recorded. Otherwise it reports the retained service truthfully.

### Step 6: Implement the CLI prompt composition

`runInstallCommand()` must:

1. parse selected adapters;
2. complete detection;
3. return immediately for dry-run with fresh installs off and recorded opt-ins preserved when delivery was omitted;
4. use the explicit policy uniformly when supplied;
5. otherwise, if interactive, ask default-No per eligible adapter;
6. otherwise preserve recorded opt-ins and use off for every fresh/unmigrated adapter;
7. pass only `deliveryByAdapter` to the deterministic planner.

The installer package remains unaware of TTYs and human prompts. A successful shell bootstrap exports its owned live policy to the vendor process as `ACC_NATIVE_DELIVERY_POLICY`; the hook runner validates only `off|actionable|all` and treats missing/invalid values as `off`.

After writing the first PATH block, human output says once: open a new terminal (or explicitly reload the named zsh rc file), then start a new client session normally. ACC cannot add a Channel/remote transport retroactively to an already-running vendor process and must not claim it did.

### Step 7: Run focused and security tests

```bash
node --test packages/adapter-sdk/test/native-delivery.test.mjs packages/installer/test/detect.test.mjs packages/installer/test/install.test.mjs packages/installer/test/ownership.test.mjs packages/installer/test/uninstall-recovery.test.mjs packages/installer/test/no-silent-downgrade.test.mjs packages/cli/test/args.test.mjs packages/cli/test/install-command.test.mjs tests/process/install-targets.test.mjs tests/process/an-upgrade-leaves-no-old-copy.test.mjs tests/security/installer.test.mjs tests/security/restore-every-client.test.mjs
```

Expected: all pass.

### Step 8: Prove old installs do not migrate

Temporarily default an absent `nativeActivation.livePolicy` to `actionable`. Run:

```bash
node --test packages/installer/test/ownership.test.mjs packages/installer/test/install.test.mjs
```

Expected: `a 0.2 ownership record keeps native delivery off` fails. Restore and rerun green.

### Step 9: Prove default-No with a mutation

Temporarily make blank confirmation return Yes. Run:

```bash
node --test packages/cli/test/install-command.test.mjs
```

Expected: the interactive default-No test fails. Restore and rerun green.

### Step 10: Commit

```bash
git add packages/adapter-sdk packages/installer packages/cli tests/process/install-targets.test.mjs tests/process/an-upgrade-leaves-no-old-copy.test.mjs tests/security/installer.test.mjs tests/security/restore-every-client.test.mjs
git commit -m "feat: install native delivery with per-client consent"
```

---

## Task 10: Implement the captured Claude Code Channel adapter

**Prerequisite:** Task 2 has a passing real-client capture. Use its exact protocol contract, minimum version, and observed modes below; if they differ from the names in this plan, first amend the approved spec and this plan in a focused documentation commit.

**Files:**

- Create: `packages/adapter-claude-code/src/channel.mjs`
- Create: `packages/adapter-claude-code/src/native-delivery.mjs`
- Create: `packages/adapter-claude-code/test/channel.test.mjs`
- Create: `packages/adapter-claude-code/test/native-delivery.test.mjs`
- Create: `packages/adapter-claude-code/plugin/.mcp.json`
- Create: `bin/acc-claude-channel.mjs`
- Modify: `packages/adapter-claude-code/src/adapter.mjs`
- Modify: `packages/adapter-claude-code/src/install.mjs`
- Modify: `packages/adapter-claude-code/test/adapter.test.mjs`
- Modify: `packages/adapter-claude-code/package.json`
- Modify: `tests/process/claude-channel-install.test.mjs`
- Create: `tests/process/claude-native-delivery.test.mjs`
- Modify: `tests/security/peer-injection.test.mjs`

### Step 1: Write the production Channel protocol tests

Port only protocol facts proven by the spike; do not import spike modules. Test a Channel server with fake Claude stdio and a temporary ACC data home:

- initializes with the exact captured `claude/channel` experimental capability;
- advertises only `acc_reply` and `acc_ack`, with closed schemas;
- accepts multiple sequential messages for one session;
- renders message id, kind, subject, untrusted marker, body, and reply id, but no system-authority wording;
- acknowledges an offer only after the Channel notification has been written successfully;
- deduplicates by stable ACC message id and never notifies twice;
- keeps a bounded id set and rejects an unsafe overflow instead of growing forever;
- routes `acc_reply` through the current ACC session generation and exact original message id;
- routes `acc_ack` likewise;
- never reads or records stdin content other than MCP/Channel protocol frames and explicit tool arguments;
- redacts message bodies, reply bodies, socket paths, and nonces from errors/logs;
- closes socket, registration, and timers when Claude closes stdin or the parent dies.

### Step 2: Write endpoint registration and adapter tests

The Channel server creates an adapter-owned registration under ACC's data home:

```js
{
  schemaVersion: 1,
  endpointId: "endpoint_test",
  clientPid: 12345,
  socketPath: "/ACC-data-home/native/claude/endpoint.sock",
  nonce: "a".repeat(64),
  protocolContract: "claude-code-channel-mcp-v1",
  modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
  leaseUntil: "2026-09-02T12:01:00.000Z"
}
```

The test data uses fixed safe values; production ids/nonces use `randomBytes`. Files and socket parents are user-owned, outside the repository, and mode `0600`/`0700` as appropriate.

If the passing capture used `rejected_busy`, omit `busyQueue` from registrations and return `recipient_busy` while the durable receipt remains queued. Never advertise `busyQueue` from the example alone.

Test these adapter methods:

```js
probeNativeDelivery({ realExecutable, timeoutMs })
planNativeActivation({ detection, context, livePolicy })
bindNativeSession({ event, clientPid, clientVersion, runtimeDir, timeoutMs })
offerMessage({ binding, message })
routeReply({ endpointId, messageId, body, session })
```

Binding must match the hook-resolved Claude PID, challenge the registration with its nonce, verify protocol/modes, and return only opaque `endpointId` to core. Offer resolves the endpoint id inside the adapter, checks ownership/permissions/socket type, sends one closed envelope, and returns:

```js
{
  accepted: true,
  transport: "claude-channel",
  clientVersion: binding.clientVersion,
}
```

Unknown, stale, ambiguous, wrong-PID, wrong-nonce, wrong-version, expired, symlinked, or unavailable registrations return a closed rejection. They never fall through to a different Claude session.

### Step 3: Run tests red

```bash
node --test packages/adapter-claude-code/test/channel.test.mjs packages/adapter-claude-code/test/native-delivery.test.mjs packages/adapter-claude-code/test/adapter.test.mjs tests/process/claude-channel-install.test.mjs tests/process/claude-native-delivery.test.mjs
```

Expected: production Channel files, manifest, and capability do not exist; the old process test still asserts live push is absent.

### Step 4: Implement the Channel binary and installed plugin wiring

`bin/acc-claude-channel.mjs` composes the production Channel with the same workspace discovery, session binding, core service, and local data-home rules as `acc-hook`; keep composition outside the adapter protocol module. It must not collect transcripts or run a model.

Add a plugin `.mcp.json` whose command/args are rewritten during install to the exact pinned Node executable and installed `bin/acc-claude-channel.mjs`, just as hook shims are rewritten. The generated file must contain no repository-local path. Installation must fail before changing the user's config if the Channel binary is absent from the installed package.

The shell activation plan uses the exact captured Channel arguments. It must not suppress Claude's experimental warning or consent.

### Step 5: Declare the earned capability

In `adapter.mjs`, add the captured contract:

```js
nativeDelivery: {
  minimumByPlatform: { "darwin-arm64": "2.1.258" },
  anchors: [{
    platform: "darwin-arm64",
    version: "2.1.258",
    protocolContract: "claude-code-channel-mcp-v1",
  }],
  knownBad: [],
  activationKinds: ["shell-bootstrap"],
},
```

Use the exact passing capture version if newer than the shown design-machine version. Set `delivery.livePush: true`. Set `delivery.replyRoute: true` only when Task 2 added passing certification for it and the production `routeReply()` test uses the real ACC conversation service.

Wire the five native methods from `native-delivery.mjs`. Keep all Claude flags, protocol names, and endpoint behavior inside this adapter package.

### Step 6: Run focused, process, boundary, and packaging tests

```bash
node --test packages/adapter-claude-code/test/channel.test.mjs packages/adapter-claude-code/test/native-delivery.test.mjs packages/adapter-claude-code/test/adapter.test.mjs tests/process/claude-channel-install.test.mjs tests/process/claude-native-delivery.test.mjs tests/security/peer-injection.test.mjs tests/package-boundaries.test.mjs tests/package-certification.test.mjs
npm pack
node scripts/verify-package.mjs
```

Expected: all pass; the packed plugin points to packed binaries, and no local worktree path exists in the tarball.

### Step 7: Prove exact-session routing with a mutation

Temporarily let `bindNativeSession()` select the first registration instead of matching `clientPid`. Run:

```bash
node --test packages/adapter-claude-code/test/native-delivery.test.mjs
```

Expected: `two Claude sessions cannot receive each other's endpoint` fails. Restore and rerun green.

### Step 8: Commit

```bash
git add packages/adapter-claude-code bin/acc-claude-channel.mjs tests/process/claude-channel-install.test.mjs tests/process/claude-native-delivery.test.mjs tests/security/peer-injection.test.mjs
git commit -m "feat: deliver ACC messages through Claude Channels"
```

---

## Task 11: Implement the captured Codex App Server queue adapter

**Prerequisite:** Task 3 has a passing real-client capture. Use its exact commands, schema, and modes. Amend spec/plan first if capture facts differ.

**Files:**

- Create: `packages/adapter-codex/src/app-server-client.mjs`
- Create: `packages/adapter-codex/src/native-delivery.mjs`
- Create: `packages/adapter-codex/test/app-server-client.test.mjs`
- Create: `packages/adapter-codex/test/native-delivery.test.mjs`
- Modify: `packages/adapter-codex/src/adapter.mjs`
- Create: `packages/adapter-codex/test/adapter.test.mjs`
- Modify: `packages/adapter-codex/package.json`
- Modify: `packages/adapter-codex/COMPATIBILITY.md`
- Modify: `tests/process/codex-live-fallback.test.mjs`
- Create: `tests/process/codex-native-delivery.test.mjs`
- Modify: `tests/security/peer-injection.test.mjs`

### Step 1: Write App Server client tests

Use a fake newline JSON-RPC peer. Test:

- initialize/initialized ordering and exact captured protocol feature discovery;
- bounded request timeouts and child cleanup;
- exact thread identity and cwd matching from the hook's Codex `session_id`;
- `thread/queue/add` with ACC `messageId` as stable `clientUserMessageId`;
- queue content labels the body as untrusted peer input and treats embedded instructions as data;
- safe retry preserving that id;
- idle acceptance and busy queue acceptance/rejection exactly as captured;
- rejection of a response that names a different thread;
- closed safe results for absent daemon, stale thread, unsupported method, malformed JSON, timeout, process exit, or vendor error;
- no transcript or previous turn request is made;
- stderr and endpoint details stay bounded and are not returned to core.

The module exports:

```js
export function openCodexAppServer({ executable, socketPath, timeoutMs, env }) {}
export async function probeCodexQueue(client, { expectedVersion }) {}
export async function locateCodexThread(client, { threadId, cwd }) {}
export async function addCodexQueueMessage(client, {
  threadId, messageId, content,
}) {}
```

### Step 2: Write adapter activation/binding tests

Test:

```js
probeNativeDelivery({ realExecutable, timeoutMs })
planNativeActivation({ detection, context, livePolicy })
bindNativeSession({ event, clientPid, clientVersion, runtimeDir, timeoutMs })
offerMessage({ binding, message })
```

The activation plan must describe only vendor-supported commands observed in Task 3:

- a `native-service` daemon bootstrap when the daemon is absent;
- whether the daemon pre-existed;
- a teardown command only if the vendor actually exposes one;
- a `shell-bootstrap` adding the captured remote/daemon argument to ordinary `codex`.

Detection runs only version, help, daemon status/version, and protocol probe calls. It must not bootstrap, start, restart, or stop anything.

The binding uses the hook's exact Codex `session_id` as the candidate App Server thread id, then verifies that id and cwd over the live protocol. Store daemon socket/thread details in an adapter-owned mode-`0600` registry and expose only an opaque endpoint id to core.

### Step 3: Run tests red

```bash
node --test packages/adapter-codex/test/app-server-client.test.mjs packages/adapter-codex/test/native-delivery.test.mjs packages/adapter-codex/test/adapter.test.mjs tests/process/codex-live-fallback.test.mjs tests/process/codex-native-delivery.test.mjs
```

Expected: production App Server modules and capability do not exist; the old fallback test asserts live push is absent.

### Step 4: Implement the adapter

Declare a static contract using the exact first passing capture, initially:

```js
nativeDelivery: {
  minimumByPlatform: { "darwin-arm64": "0.152.1" },
  anchors: [{
    platform: "darwin-arm64",
    version: "0.152.1",
    protocolContract: "codex-app-server-thread-queue-v1",
  }],
  knownBad: [],
  activationKinds: ["native-service", "shell-bootstrap"],
},
```

Use the actual passing capture version if it differs. Set only `delivery.livePush: true` unless native reply routing was separately captured and implemented. `offerMessage()` initializes a short-lived App Server proxy/client, verifies the thread binding, adds the queue message, waits for the vendor acknowledgement, closes, and returns `codex-app-server` plus the bound client version. This short transport call may be an ACC child; the Codex model session and daemon remain vendor-owned, and ACC never supervises or restarts the model.

### Step 5: Implement service ownership behavior

When install apply sees an absent daemon and the user opted in, run the captured vendor bootstrap. Record `createdByAcc: true`. On uninstall:

- run a captured vendor teardown only if it exists and ACC created the service;
- otherwise leave the vendor daemon in place and report that no supported automatic teardown exists;
- never restart, kill, or replace a daemon that pre-existed;
- removal of the ACC shim/config must still succeed if daemon cleanup is unavailable.

### Step 6: Run focused, process, boundary, and package tests

```bash
node --test packages/adapter-codex/test/app-server-client.test.mjs packages/adapter-codex/test/native-delivery.test.mjs packages/adapter-codex/test/adapter.test.mjs tests/process/codex-live-fallback.test.mjs tests/process/codex-native-delivery.test.mjs tests/security/peer-injection.test.mjs tests/package-boundaries.test.mjs tests/package-certification.test.mjs
npm pack
node scripts/verify-package.mjs
```

Expected: all pass. A down daemon, stale thread, or failed queue request leaves the message durably queued.

### Step 7: Prove idempotency with a mutation

Temporarily generate a new `clientUserMessageId` inside `offerMessage()` instead of using `message.messageId`. Run:

```bash
node --test packages/adapter-codex/test/app-server-client.test.mjs tests/process/codex-native-delivery.test.mjs
```

Expected: the retry/deduplication gate fails. Restore and rerun green.

### Step 8: Commit

```bash
git add packages/adapter-codex tests/process/codex-live-fallback.test.mjs tests/process/codex-native-delivery.test.mjs tests/security/peer-injection.test.mjs
git commit -m "feat: deliver ACC messages through Codex queues"
```

---

## Task 12: Keep Grok, Gemini, and Kimi capability claims honest

**Files:**

- Modify: `packages/adapter-grok/src/adapter.mjs`
- Modify: `packages/adapter-grok/test/adapter.test.mjs`
- Create conditionally after a passing Task 4 capture: `packages/adapter-grok/src/native-delivery.mjs`
- Modify conditionally after a passing Task 4 capture: `packages/adapter-grok/src/install.mjs`
- Modify conditionally after a passing Task 4 capture: `packages/adapter-grok/package.json`
- Modify: `packages/adapter-gemini-cli/COMPATIBILITY.md`
- Modify: `packages/adapter-kimi/COMPATIBILITY.md`
- Modify: `docs/CAPABILITIES.md`

### Step 1: Follow exactly one Grok branch

If Task 4 is a fail, add tests proving Grok:

- declares no native contract;
- keeps `delivery.livePush`, `idleWake`, `busyQueue`, and `replyRoute` false/absent;
- produces no native activation plan or install prompt;
- still installs its existing hooks/config and preserves durable next-turn behavior;
- reports `awaiting_compatibility_capture`, not a generic success.

Do not create `native-delivery.mjs` in this branch.

If Task 4 is a pass, implement only the exact captured public leader transport with the same minimum+anchor+probe+handshake pattern as Tasks 10–11. Do not use ACP as an ACC-owned launch wrapper. Add process tests for exact-session delivery, busy behavior, reply, duplicate, fallback, and ordinary `grok` launch before setting the capability true.

### Step 2: Keep Gemini and Kimi fallback-only

Update compatibility docs with the observed reason:

- Gemini's ordinary TUI has no captured external wake/injection path; ACP changes launch/ownership and is therefore outside this feature boundary.
- Kimi exposes server/queue APIs, but no capture proves transparent binding to an independently opened ordinary TUI session.

Do not add shims, prompts, minimums, or speculative native adapters for either client.

### Step 3: Run tests

For the expected failed Grok branch:

```bash
node --test packages/adapter-grok/test/adapter.test.mjs packages/adapter-gemini-cli/test/adapter.test.mjs packages/adapter-kimi/test/adapter.test.mjs tests/conformance/certification-evidence.test.mjs tests/docs/commands.test.mjs
```

For a passing Grok branch, also run its new native/process tests and package verification.

### Step 4: Prove capability honesty with a mutation

In the failed-capture branch, temporarily declare Grok `delivery.livePush: true`. Run:

```bash
node --test packages/adapter-grok/test/adapter.test.mjs tests/conformance/certification-evidence.test.mjs
```

Expected: adapter definition/certification tests fail. Restore and rerun green.

### Step 5: Commit

For the expected fallback-only result:

```bash
git add packages/adapter-grok packages/adapter-gemini-cli/COMPATIBILITY.md packages/adapter-kimi/COMPATIBILITY.md docs/CAPABILITIES.md
git commit -m "docs: record native delivery support boundaries"
```

If Grok passed and was implemented, use `feat: deliver ACC messages through Grok leader transport` instead.

---

## Task 13: Expose truthful states, simplify the docs, and prove the installed product

**Files:**

- Modify: `packages/cli/src/doctor-command.mjs`
- Modify: `packages/cli/src/main.mjs`
- Create: `packages/cli/test/native-delivery-doctor.test.mjs`
- Modify: `tests/process/doctor-reports.test.mjs`
- Modify: `tests/process/surface-coverage.test.mjs`
- Modify: `tests/acceptance/cross-vendor-live.test.mjs`
- Modify: `tests/acceptance/cross-vendor.md`
- Modify: `tests/acceptance/release-workflow.test.mjs`
- Modify: `tests/acceptance/packaging.test.mjs`
- Modify: `tests/helpers/packed-acc.mjs`
- Modify: `README.md`
- Modify: `docs/index.md`
- Modify: `docs/GETTING_STARTED.md`
- Modify: `docs/HOW_IT_WORKS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONCEPTS.md`
- Modify: `docs/CLI.md`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/CAPABILITIES.md`
- Modify: `docs/PROTOCOL.md`
- Modify: `docs/SECURITY_MODEL.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/DESIGN_DECISIONS.md`
- Modify: `docs/RELEASING.md`
- Modify: `packages/adapter-claude-code/plugin/skills/acc/SKILL.md`
- Modify: `packages/adapter-codex/plugin/skills/acc/SKILL.md`
- Modify as applicable: other adapter ACC skills containing the obsolete “no shipped adapter” sentence

### Step 1: Write doctor/status tests for separate truths

For each detected adapter, doctor JSON must report independently:

```js
{
  adapterId: "claude_code",
  client: { state: "detected", version: "2.1.258" },
  nativeDelivery: {
    eligibility: "eligible",
    configured: true,
    policy: "actionable",
    runtime: "active",
    modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
    reasonCode: null,
  },
}
```

Closed values:

- eligibility: `eligible|unsupported|degraded`;
- configured: boolean;
- policy: `off|actionable|all`;
- runtime: `inactive|active|degraded|unsupported`;
- modes: closed binding-mode array;
- reasonCode: null or closed safe code.

Test combinations including detected-but-not-eligible, eligible-but-not-configured, configured-but-no-live-session, active binding, expired binding, failed handshake, below minimum, newer-probe-pass, known bad, and unsupported shell. Human output must explain one next action without claiming `offered` means seen.

`acc status --json` reports runtime binding modes and lease state for sessions, but never endpoint refs, nonces, socket paths, daemon paths, or raw errors.

### Step 2: Run doctor/status tests red

```bash
node --test packages/cli/test/native-delivery-doctor.test.mjs tests/process/doctor-reports.test.mjs tests/process/surface-coverage.test.mjs
```

Expected: current doctor has installation/ownership diagnostics but no complete native state model.

### Step 3: Implement the closed reporting model

Build state only from detection, ownership, and current core binding facts. Never infer activity from a configured shim alone. Keep human labels concise:

```text
Claude Code  eligible · enabled (actionable) · active
Codex        eligible · enabled (actionable) · waiting for a live session
Grok         unsupported · no captured ordinary-session transport
Gemini       unsupported · next-turn fallback only
Kimi         not installed
```

### Step 4: Rewrite the user path before the reference path

README first screen must answer, in this order:

1. **What:** “ACC lets independently opened AI coding sessions notice and talk to each other.”
2. **Why:** one concrete Claude↔Codex question/answer example.
3. **Boundary:** “You still launch each client normally; ACC does not run or supervise agents.”
4. **Try:** Node requirement, one install command, one `acc install`, normal `claude`/`codex`, one status/message command.
5. **Truth:** a compact support matrix with Claude/Codex experimental native delivery and explicit fallback-only clients.
6. Links to `GETTING_STARTED`, `HOW_IT_WORKS`, and security/compatibility details.

Keep the README concise; move mechanism detail to `HOW_IT_WORKS`. Update the diagrams to show:

```text
sender -> durable ACC record -> exact live binding -> vendor transport -> receiver
                              \-> queued inbox on every failure
```

Document plainly:

- opt-in interactive install and default No;
- activation applies to new client processes; an already-running session keeps durable/next-turn fallback until restarted normally, and a new PATH block needs a new or reloaded shell;
- `--delivery off|actionable|all` automation behavior;
- repeated `--adapter` selection;
- `ACC_BYPASS=1` escape hatch;
- no maximum client version, but mandatory runtime probe and handshake;
- first captured platform/minimum and known-bad behavior;
- room messages never live;
- actionable includes question, request, answer, decision, handoff;
- `recorded`, `queued`, `offered`, `retrieved`, and `acknowledged` remain distinct;
- experimental Claude warning is vendor-owned and visible;
- Codex daemon ownership/teardown limitations;
- no transcript collection and no orchestration.

Update every installed ACC skill so it no longer says “no shipped adapter currently has certified live push.” Replace it with behavior-based guidance: a queued message remains safe; an offered message reached a native transport but is not proof the model read it.

### Step 5: Add installed-tarball acceptance coverage

Extend `packed-acc.mjs` so a test can install the tarball into a temporary prefix/home with fake vendor binaries and TTY streams. The acceptance suite must prove:

- the packed bootstrap and Claude Channel binaries exist and have no local-worktree path;
- interactive Yes/No produces per-adapter ownership;
- normal `claude`/`codex` command names resolve through shims;
- successful fake probes add only captured vendor args and use `exec`;
- newer fake versions pass matching probes;
- old/known-bad/wrong-protocol clients launch untouched;
- a real durable message is written before a fake native offer;
- one Claude-style and one Codex-style exact binding can exchange question then answer;
- killing each fake transport leaves the next message queued;
- uninstall restores byte-identical shell/config files and preserves modified/user-owned files;
- a second uninstall is an idempotent no-op.

Keep the existing real-client acceptance test opt-in through explicit environment variables so ordinary CI never claims a real capture it did not run. The release workflow test must fail when the packaged capability is true but its current adapter has no passing capture, no matching minimum anchor, or no installed-path acceptance test.

### Step 6: Run docs, acceptance, and full gates

```bash
node --test packages/cli/test/native-delivery-doctor.test.mjs tests/process/doctor-reports.test.mjs tests/process/surface-coverage.test.mjs tests/acceptance/cross-vendor-live.test.mjs tests/acceptance/release-workflow.test.mjs tests/acceptance/packaging.test.mjs tests/docs/commands.test.mjs tests/docs/diagrams.test.mjs tests/docs/skills.test.mjs tests/docs/executable.test.mjs tests/acceptance/package-links.test.mjs
env NPM_CONFIG_CACHE=/private/tmp/acc-transparent-native-delivery-npm-cache npm run check
env NPM_CONFIG_CACHE=/private/tmp/acc-transparent-native-delivery-npm-cache npm test
npm pack
node scripts/verify-package.mjs
```

Expected: every command passes, the test runner executes a non-empty list, and the tarball verification sees all runtime files.

### Step 7: Prove the release gate with mutations

Perform and restore these one at a time:

1. Remove the Claude passing capture entry while leaving `livePush: true`; `tests/acceptance/release-workflow.test.mjs` must fail.
2. Replace the packed Claude Channel command with the current worktree path; `tests/acceptance/packaging.test.mjs` or `verify-package.mjs` must fail.
3. Mark an offered receipt before the fake transport accepts; `tests/acceptance/cross-vendor-live.test.mjs` must fail.
4. Change the uninstall hash check to remove a user-modified zsh block; `tests/security/restore-every-client.test.mjs` must fail.

Restore each mutation with `apply_patch` and rerun its exact test green before the next mutation.

### Step 8: Perform the two real-client release captures

On the captured `darwin-arm64` machine, install the just-built tarball, opt Claude and Codex into `actionable`, and start them through ordinary commands in the same disposable workspace:

```text
claude
codex
```

Do not use `acc run`, an ACC parent wrapper, or a hidden manual injection. Prove:

1. both sessions appear live with active generation-bound native modes;
2. Claude sends an ACC question to Codex;
3. Codex receives it without a new human prompt and sends an explicit ACC answer;
4. Claude receives the answer without a new human prompt;
5. duplicate offer attempts do not duplicate either model-visible message;
6. a busy receiver queues after the current turn or rejects honestly;
7. killing each transport leaves the next durable message queued;
8. `ACC_BYPASS=1 claude` and `ACC_BYPASS=1 codex` launch without native arguments;
9. uninstall restores owned shell/client bytes and does not remove a pre-existing vendor daemon.

Capture ids, versions, timestamps, branch outcomes, and hashes only. Do not store prompts, answers, or transcripts. If the installed artifact differs from the earlier spike on any required branch, change the capability back to false, record the failure, and stop before release.

### Step 9: Final mutation and full verification

The rule that matters most is still the final check. Temporarily alter the production shell fallback to keep one native flag after a failed probe. Run the installed-tarball fallback acceptance test and observe it fail. Restore with `apply_patch`, rebuild the tarball, then rerun:

```bash
env NPM_CONFIG_CACHE=/private/tmp/acc-transparent-native-delivery-npm-cache npm run check
env NPM_CONFIG_CACHE=/private/tmp/acc-transparent-native-delivery-npm-cache npm test
npm pack
node scripts/verify-package.mjs
git diff --check
git status --short
```

Expected: all gates pass; only intentional files are modified before commit.

### Step 10: Commit the completed vertical slice

```bash
git add README.md docs packages/cli packages/adapter-claude-code/plugin/skills packages/adapter-codex/plugin/skills tests
git commit -m "docs: explain transparent native delivery"
```

Do not tag or publish here. Hand the verified branch to `superpowers:finishing-a-development-branch`; merging and release require an explicit user request under the repository rules.

---

## Completion checklist

- [ ] Claude Code has a passing real-client capture and matching installed-tarball capture on the claimed platform.
- [ ] Codex has a passing real-client capture and matching installed-tarball capture on the claimed platform.
- [ ] Every `true` capability has fixture and certification evidence.
- [ ] Newer stable client versions are admitted only after a matching feature probe and session handshake; there is no maximum version.
- [ ] Older, prerelease, known-bad, changed-protocol, and failed-handshake clients launch normally with durable fallback.
- [ ] Ordinary client commands remain `claude`, `codex`, and—only if captured—`grok`.
- [ ] `ACC_BYPASS=1` bypasses ACC completely.
- [ ] ACC is not the parent or supervisor of a model session after shell `exec`.
- [ ] Questions and answers both qualify under `actionable`; room messages never do.
- [ ] Exact participant/session/generation routing and duplicate suppression are proven.
- [ ] No raw transcript, non-ACC prompt, model output, endpoint secret, or vendor raw error is collected; explicit ACC message/reply bodies remain the only intentional shared content.
- [ ] Interactive install defaults No and non-interactive omitted delivery defaults off.
- [ ] Existing 0.2 ownership records do not migrate or silently activate live delivery.
- [ ] Uninstall removes only hash-matching ACC-owned bytes and only ACC-created services with supported teardown.
- [ ] Doctor distinguishes eligibility, configuration, policy, runtime activity, and degradation.
- [ ] Syntax, full suite, docs, package, security, and release gates pass.
- [ ] Every new gate has an observed mutation failure recorded in the task notes/commit message body.
