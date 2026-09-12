# Complete Delivery Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete supported local delivery setup after one installation choice and explain incomplete setup accurately.

**Architecture:** Extend detect/plan/apply and the existing ownership record. Vendor service inspection and preparation stay in the adapter; explicit install is the only caller allowed to prepare a missing service. Runtime readiness and saved consent remain separate facts.

**Tech Stack:** Node 24, ESM, node:test, Node built-ins; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-complete-delivery-setup-design.md`

## Global Constraints

- Work only in `.gitworktrees/feat-complete-delivery-setup`, branch `feat/complete-delivery-setup`; never push or merge.
- Preserve all AGENTS.md invariants, package boundaries, ownership checks, and fail-open hooks.
- No real user configuration, daemon, auth, or model invocation in tests. Use private temporary homes.
- No added runtime dependencies. Production modules and focused tests stay below 300 lines or have a cohesion justification.
- Every new/corrected test gate must demonstrably fail on the behavior it protects; record the failing command and assertion, then green output.
- Preserve historical release evidence. New capability claims require an actual client capture.
- Supported cold preparation: darwin-arm64 PID backend, Codex >=0.154.0, matching existing managed standalone and CLI versions. Do not download/copy the vendor binary in production.
- No lifecycle mutations from doctor, hooks, routing, automatic refresh, dry run, or off/default-no installations.
- Commit each independently reviewable task. Report exact test commands and results in the task report.

---

### Task 1: One consent decision with durable provenance

**Files:**
- Modify `packages/cli/src/install-command.mjs`, `packages/installer/src/plan.mjs`, `packages/installer/src/apply.mjs`, `packages/installer/src/ownership.mjs`.
- Modify `packages/cli/src/managed-runtime/refresh.mjs` to preserve decision data.
- Create `packages/cli/src/install-delivery-consent.mjs` if needed to keep the decision logic cohesive.
- Test `packages/cli/test/install-command.test.mjs` and focused new `packages/cli/test/install-delivery-consent.test.mjs`; installer ownership/plan tests as needed.

**Interfaces:**
- `decideDelivery({options, detected, recorded, runtime, dryRun})` returns existing `deliveryByAdapter`, `asked`, `notes`, plus `deliveryDecisionByAdapter`.
- A `deliveryDecision` is `{source, completeSetup}`. Sources: `interactive-accepted`, `interactive-declined`, `explicit-option`, `noninteractive-default`, `unsupported-default`, `legacy-unknown`.
- `planInstallation` accepts optional `deliveryDecisionByAdapter = {}` and `allowServiceSetup = false`. Each install operation carries `deliveryDecision`, preserving the recorded entry when no replacement is supplied.
- `recordInstall` accepts/stores optional `deliveryDecision`, retaining it on maintenance refresh. `runInstallCommand` passes `allowServiceSetup: true` only for the explicit install path.
- Task 2 detection adds `entry.nativeServiceSetup` with state `ready`, `needed`, `blocked`, or `unsupported`. Treat `needed` or `blocked` as reasons to ask an existing non-off client for expanded complete-setup consent when absent; do not ask that client if consent is already recorded.

- [ ] **Step 1: Add failing behavioral tests.** Reuse the existing detected-entry fixtures. Two eligible clients must invoke confirm once and share its response:

```js
const questions = [];
const result = await decideDelivery({ options: {}, detected: [claude, codex],
  recorded: [], dryRun: false, runtime: { isInteractive: () => true,
    confirm: async question => { questions.push(question); return true; } } });
assert.equal(questions.length, 1);
assert.deepEqual(result.deliveryByAdapter, { claude_code: "actionable", codex: "actionable" });
assert.deepEqual(result.deliveryDecisionByAdapter.codex,
  { source: "interactive-accepted", completeSetup: true });
```

Add cases for No, default/noninteractive, dry run, explicit actionable/all/off, preserved non-off, unsupported client, legacy non-off needing setup accepted/declined, and reinstall after complete consent. Assertions must check counts, policies, decision values, and absence of side effects; avoid only checking prompt wording.

- [ ] **Step 2: Run the focused tests and record the precise red assertion.** Run `node --test packages/cli/test/install-delivery-consent.test.mjs`. Verify the old implementation produces two prompts or missing provenance, not a fixture/import failure.

- [ ] **Step 3: Implement the decision and persistence path.** Collect eligible undecided clients and legacy opted-in clients needing expanded service setup. Invoke confirm once for the set, naming every client and describing token use, local grants, startup, and existing Channels requirements. The decision update is:

```js
for (const entry of candidates) {
  const previous = livePolicyOf(recordedById.get(entry.adapterId));
  deliveryByAdapter[entry.adapterId] = yes ? (previous === "off" ? "actionable" : previous) : previous;
  deliveryDecisionByAdapter[entry.adapterId] = yes
    ? { source: "interactive-accepted", completeSetup: true }
    : previous === "off" ? { source: "interactive-declined", completeSetup: false }
      : decisionOf(recordedById.get(entry.adapterId));
}
```

Define `decisionOf(record)` locally to normalize known sources and default missing/invalid values to `{source: "legacy-unknown", completeSetup: false}`. Explicit options set source explicit-option and completeSetup to policy !== off. Fresh noninteractive and unsupported defaults get their named sources; retained decisions are not overwritten. Dry run does not store decisions. Keep default-No confirmation handling.

- [ ] **Step 4: Run focused CLI and installer tests.** Include existing confirm/install/ownership/plan/refresh coverage. Show a mutation removing one persistence assignment fails a new round-trip assertion. Restore it and record green.
- [ ] **Step 5: Commit** with `feat: unify delivery setup consent and retain its source`.

### Task 2: Prepare a missing supported Codex service during explicit install

**Files:**
- Create `packages/adapter-codex/src/service-setup.mjs` and focused tests in `packages/adapter-codex/test/service-setup.test.mjs` (split behavioral groups if needed).
- Modify `packages/adapter-codex/src/adapter.mjs`, `maintenance-host.mjs`, and `native-delivery.mjs` only where necessary to share verified host checks and correct lifecycle comments.
- Modify `packages/installer/src/detect.mjs`, `plan.mjs`, and `apply.mjs`; create `packages/installer/src/service-setup.mjs` if orchestration merits a separate module.
- Add installer service-setup tests with fake adapter ports, and append real observations to `packages/adapter-codex/COMPATIBILITY.md` with a new fixture under its existing fixture convention.

**Interfaces:**
- Adapter `inspectNativeServiceSetup(context)` returns `{state, reasonCode, diagnostic, ...pinnedFacts}`. `state` is ready/needed/blocked/unsupported. It performs read-only version, filesystem, identity, and native protocol probes.
- Adapter `prepareNativeServiceSetup({context, plan})` returns `{state: "ready"|"failed"|"blocked", started: boolean, reasonCode, diagnostic}`. Inject process/filesystem/protocol dependencies through a factory for tests, following maintenance host conventions.
- Detection records `entry.nativeServiceSetup` independently of native delivery eligibility. Failures yield a safe blocked diagnostic without hiding other adapters.
- Plan copies `nativeServiceSetup` into an operation only if explicit `allowServiceSetup`, requested policy non-off, and `deliveryDecision.completeSetup === true`; it shows the action in summaries. Automatic refresh defaults false.
- Apply records adapter install and consent before trying service preparation. Record setup result if useful for diagnostics, but never use a historical success as live readiness. Preparation failure adds to `result.failed` while retaining the applied operation and ownership; blocked prerequisites become needsAction. Other adapters continue.

- [ ] **Step 1: Add failing service and installer tests.** Verify definite absence starts the pinned executable once with exact HOME/CODEX_HOME, then verifies the real protocol; a healthy service starts zero times. For orchestration use a fake adapter whose install writes an owned file and whose setup fails:

```js
const result = await applyPlan({ plan, adapters: [adapter], context, dataHome });
assert.equal(result.operations[0].applied, true);
assert.equal(result.failed.length, 1);
const saved = (await loadOwnership({dataHome})).installs[0];
assert.equal(saved.deliveryPolicy, "actionable");
assert.equal(saved.deliveryDecision.completeSetup, true);
assert.deepEqual(calls, ["install", "prepare"]);
```

Cover off, dry run, no complete consent, automatic-refresh plan, unsupported platform/version, missing/mismatched managed install, unsafe/stale endpoint or PID, changed executable/home between plan and apply, start timeout/nonzero, protocol verification failure, and a healthy service racing the plan. Test absence checks with actual temp filesystem entries where possible; no model request.

- [ ] **Step 2: Run new focused tests and capture red** caused by absent setup behavior. Do not count import errors as red proof.
- [ ] **Step 3: Implement the adapter operation and installer integration.** Reuse `maintenanceContext`/`probeMaintenanceInstall` and identity helpers without pretending cold start has an approved old PID. Validate pinned home/executable and definite absence again immediately before starting. The only new mutating command is equivalent to:

```js
await run(plan.cliPath, ["app-server", "daemon", "start"], {
  cwd: plan.codexHome, env: { ...context.env, HOME: plan.home, CODEX_HOME: plan.codexHome },
  timeout: 15_000,
});
```

Require bounded post-start service identity and `probeNativeDelivery` verification. An empty service is ready infrastructure, not a bound session. Never remove stale metadata or stop/restart on this path. Reuse a raced healthy service only after checks. Report missing managed installation with the existing vendor-supported action, avoiding false success. Preserve install ownership if service work fails. Do not grant new hooks/delivery capabilities.

- [ ] **Step 4: Run focused adapter/installer tests and verify mutations.** Suppress the native protocol verification and show its test fails; suppress the allowServiceSetup gate and show refresh/no-consent coverage fails. Restore and record green. Capture a real supported cold start in a private HOME/CODEX_HOME using an explicitly described managed-install fixture, verify service identity and native probe, stop only the fixture process, and append evidence. The controller provides the independent capture artifact path; inspect it rather than guessing.
- [ ] **Step 5: Commit** with `feat: prepare supported Codex service after setup consent`.

### Task 3: Diagnose incomplete setup and prove the packed onboarding flow

**Files:**
- Modify `packages/cli/src/doctor-command.mjs` and associated focused doctor tests.
- Modify `packages/adapter-codex/src/live-permissions.mjs` and focused permissions tests.
- Modify/add packed tests beside `tests/acceptance/delivery-setup-packed.test.mjs` and `codex-live-permissions-packed.test.mjs`.
- Update current onboarding docs found from `docs/index.md`, relevant CLI help, and comments that say ACC never starts the Codex daemon. Preserve unrelated maintenance/restart semantics and historical evidence.

**Interfaces:**
- Consume stored `deliveryDecision` from Task 1 and detected `nativeServiceSetup`/operation preparation outcomes from Task 2.
- `doctor` includes decision source for off without inventing one for legacy records. It emits each outgoing permission remediation once and uses current probes for readiness.
- Permission preparation retains already owned valid ACC grants when requested incoming policy is off; fresh off creates none, custom/modified ownership remains protected, uninstall restores previous bytes.

- [ ] **Step 1: Add failing diagnostics and permission assertions.** After an approved install, disable incoming delivery and check the ACC outgoing grants still exist; uninstall and check exact original bytes. Fresh off must leave an empty/default config without live grants. Custom permissions must remain byte-identical. For doctor assert one outgoing remediation and distinct absent-vs-custom explanations, with known/unknown off origins.

```js
assert.equal(report.data.installs.find(x => x.adapterId === "codex")
  .deliveryDecision.source, "interactive-declined");
assert.equal(report.text.split("sender permissions unverified").length - 1, 1);
assert.match(await readFile(configPath, "utf8"), /acc-workspace/);
```

Adapt the doctor assertion to its actual public JSON structure; do not add a redundant `installs` field merely for this example.

- [ ] **Step 2: Run the changed tests before production edits** and capture failing behavioral assertions, then implement minimal diagnostics and permission retention.
- [ ] **Step 3: Exercise the packed CLI with one real confirmation interaction.** Reuse `createPackedAcc`, private homes, existing fake client protocol fixtures, and TTY input/output setup. With Claude and Codex selected, one yes must save actionable plus complete consent for both and show the supported preparation result. A missing managed prerequisite must be needsAction; it must not falsely say ready. Add No, explicit noninteractive actionable, dry run, and repeat-install coverage. Observe actual ownership/configuration/command log side effects, not just summary text. Prove the one-prompt and no-start guards with exact mutations and restore them.
- [ ] **Step 4: Update current docs** to describe one choice, explicit automation flags, custom permission preservation, supported service prerequisites, client-owned startup/trust actions, and infrastructure-ready versus session-bound. State that disabling incoming requests retains already approved outgoing grants. Do not imply universal reboot persistence or hook availability.
- [ ] **Step 5: Run relevant focused and packed tests**, inspect the final diff, and commit with `fix: explain incomplete delivery setup and preserve outgoing grants`.

## Final verification

- [ ] Run `npm ci`, `npm run check`, `npm test`, then `npm pack && node scripts/verify-package.mjs` from the worktree. For sandbox-safe npm use `npm_config_cache=/private/tmp/acc-onboarding-npm-cache npm_config_offline=true npm_config_audit=false npm_config_fund=false`; use `ACC_NO_UPDATE_CHECK=1` when tests otherwise initiate the background updater.
- [ ] Review the whole branch against the spec, AGENTS.md, actual-client evidence, and packed behavior. Fix critical/important findings and run their covering checks.
- [ ] Confirm a clean worktree and focused commits. Retain the branch for the user; do not push, merge, publish, or alter the real client installation.
