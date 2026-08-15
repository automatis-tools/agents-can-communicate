# ACC Prototype Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one combined, fully verified prototype snapshot containing all four archived hardening sets before project-agnostic extraction begins.

**Architecture:** Keep the preserved baseline immutable. Copy it to `prototype/integrated/`, port the four patch semantics in dependency order, and add combined regressions for cross-patch behavior. Low-level storage's managed-root API wins conflicts; lifecycle and doctor semantics are ported onto that API.

**Tech Stack:** Node.js ESM, Node built-in `node:test`, dependency-free filesystem storage, Git patches as evidence.

## Global Constraints

- Do not edit `prototype/papercut-agent-comms/` or `migration/patches/*.patch`.
- Start from source commit `9a866cf16f97a0aa1af7ea792acc79bc02278633` as preserved.
- Every new or changed gate needs an intentional mutation that demonstrates RED before GREEN.
- Keep production and focused test modules below 300 lines.
- Preserve machine JSON stdout purity.
- Do not begin standalone renaming or package extraction in this plan.

---

### Task 1: Create the mutable integration snapshot

**Files:**
- Create: `prototype/integrated/tools/agents/**`
- Create: `prototype/integrated/tests/tools/agent_comms/**`
- Create: `prototype/integrated/docs/**`
- Create: `prototype/integrated/SOURCE.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: immutable tree at `prototype/papercut-agent-comms/`
- Produces: runnable snapshot selected by `npm run test:integrated`

- [ ] **Step 1: Prove the immutable baseline is green**

Run:

```bash
npm run test:prototype
```

Expected historical baseline: 181 tests. Record the exact observed count and outcome in `prototype/integrated/SOURCE.md`; do not hide the known fixed-delay failure if it occurs.

Also run the focused SIGTERM test and the parallel diagnostic:

```bash
cd prototype/papercut-agent-comms
node --test --test-name-pattern='SIGTERM is accepted' tests/tools/agent_comms/cli-round1.test.mjs
cd ../../..
npm run test:prototype
```

The preserved baseline is known to use a fixed 80-ms startup delay. If the focused test passes but parallel execution returns `null !== 0`, record this exact harness RED rather than treating it as production watcher failure.

- [ ] **Step 2: Copy the baseline mechanically**

Copy the contents of `prototype/papercut-agent-comms/` to `prototype/integrated/`. Do not copy `prototype/README.md` over the snapshot.

- [ ] **Step 3: Replace the fixed-delay test harness with readiness**

In `prototype/integrated/tests/tools/agent_comms/cli-round1.test.mjs`, wait until the watcher ownership or online presence record exists and validates before sending SIGTERM. Bound the condition loop and include the last observed child stdout/stderr in timeout failure. Do not add a larger sleep.

- [ ] **Step 4: Add source provenance**

Create `prototype/integrated/SOURCE.md` with:

```markdown
# Integrated prototype provenance

Baseline: `9a866cf16f97a0aa1af7ea792acc79bc02278633`
Archived source: `../papercut-agent-comms/`
Hardening evidence: `../../migration/patches/`

This directory is the mutable reconciliation target. It is not the standalone
package layout.
```

- [ ] **Step 5: Add the integrated test script**

Add to root `package.json` scripts:

```json
"test:integrated": "cd prototype/integrated && node --test tests/tools/agent_comms/*.test.mjs"
```

- [ ] **Step 6: Verify copied production identity and intentional test delta**

Run:

```bash
diff -ru prototype/papercut-agent-comms/tools prototype/integrated/tools
diff -ru prototype/papercut-agent-comms/tests prototype/integrated/tests || true
npm run test:integrated
```

Expected: production diff empty; test diff contains only the condition-based SIGTERM readiness change; integrated suite passes under default parallel execution.

- [ ] **Step 7: Commit**

```bash
git add package.json prototype/integrated
git commit -m "chore: create integrated protocol snapshot"
```

---

### Task 2: Port storage and message hardening

**Files:**
- Modify: paths listed by `migration/patches/0003-storage-and-messages.patch` under `prototype/integrated/`
- Test: corresponding `*-storage.test.mjs` and `*-process-storage.test.mjs` files under `prototype/integrated/tests/tools/agent_comms/`

**Interfaces:**
- Consumes: baseline read/write helpers
- Produces: root-aware safe read APIs:

```js
readJsonStrict(file, validate, root, openFile)
readJsonRegularNoFollow(file, validate, root, openFile)
readRegularNoFollow(file, root, openFile)
listDirectoryEntries(dir, { root, readDirectory })
listJsonFiles(dir, { root, readDirectory })
```

- [ ] **Step 1: Reconstruct storage tests from the archived patch**

Port only test additions from `0003-storage-and-messages.patch`. Adjust paths so they target `prototype/integrated/tools/agents/`.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
node --test prototype/integrated/tests/tools/agent_comms/{atomic-json,identity,messages,paths,schema}-storage.test.mjs prototype/integrated/tests/tools/agent_comms/{atomic-json,messages}-process-storage.test.mjs
```

Expected: failures prove symlink-parent acceptance, unsafe IDs, filename mismatch, or overwrite-capable archive behavior. Archive exact failure names in the commit body.

- [ ] **Step 3: Port minimal storage production behavior**

Port `safe-directory.mjs`, `message-id.mjs`, root-aware read/list signatures, contained publication checks, portable identifier validation, and no-replace archive publication. Preserve injected opener seams as the final argument.

The no-replace archive contract must behave as:

```js
if (destinationExists && deepEqual(existing, expected)) return "already_published";
if (destinationExists) throw new CommsError(EXIT.DATA, "archive conflict");
return publishWithoutReplacement(source, destination);
```

- [ ] **Step 4: Run focused GREEN**

Run the Step 2 command. Expected: every focused test passes.

- [ ] **Step 5: Run compatibility tests**

```bash
cd prototype/integrated
node --test tests/tools/agent_comms/{atomic-json,identity,messages,paths,schema,claims,status,repair-mutex}.test.mjs
```

Expected: all selected legacy behavior remains green.

- [ ] **Step 6: Commit**

```bash
git add prototype/integrated
git commit -m "fix: harden integrated message storage"
```

---

### Task 3: Port lifecycle and CLI hardening onto root-aware storage

**Files:**
- Modify: paths listed by `migration/patches/0002-lifecycle-and-cli.patch` under `prototype/integrated/`
- Test: `final-cli.test.mjs`, `final-lifecycle.test.mjs`, `foreign-checkout.test.mjs`

**Interfaces:**
- Consumes: root-aware APIs from Task 2
- Produces: protocol/identity guard before every normal command; serialized registration lifecycle; live-recipient broadcast; JSON-pure errors

- [ ] **Step 1: Port lifecycle tests only**

Copy the three new focused tests from the archived patch and port changes to existing identity/integration tests. Keep every direct safe-read call on Task 2's root-aware signature.

- [ ] **Step 2: Capture lifecycle RED**

```bash
node --test prototype/integrated/tests/tools/agent_comms/{final-cli,final-lifecycle,foreign-checkout}.test.mjs
```

Expected: the baseline permits at least protocol mutation, stale open identity replacement, offline broadcast, foreign checkout mutation, or non-JSON stderr behavior.

- [ ] **Step 3: Port lifecycle behavior, not old helper signatures**

Implement these command preconditions:

```js
if (command !== "init" && command !== "prompt") {
  await requireCompatibleWorkspace(context);
}
```

`requireCompatibleWorkspace` must validate schema version, protocol version, workspace identity, and root before mutation. Preserve Task 2's managed-root reads.

Serialize register, resume, close, watcher start, and watcher stop through one per-participant ownership critical section.

- [ ] **Step 4: Add malformed foreign protocol regression**

Add a black-box test that points a command and `doctor --repair` at another Workspace with a malformed or unknown-version protocol. Both must exit with the data/protocol error and leave every foreign byte unchanged.

- [ ] **Step 5: Add init-before-layout regression**

Create a valid protocol belonging to another Workspace with no layout directories. Call `init`. Expected: identity failure and no directories created.

- [ ] **Step 6: Run focused and complete GREEN**

```bash
node --test prototype/integrated/tests/tools/agent_comms/{final-cli,final-lifecycle,foreign-checkout}.test.mjs
npm run test:integrated
```

- [ ] **Step 7: Commit**

```bash
git add prototype/integrated
git commit -m "fix: harden integrated agent lifecycle"
```

---

### Task 4: Port doctor and recovery hardening onto root-aware storage

**Files:**
- Modify: paths listed by `migration/patches/0004-doctor-and-recovery.patch` under `prototype/integrated/`
- Test: `claims-recovery-replay.test.mjs`, `status-recovery-audits.test.mjs`

**Interfaces:**
- Consumes: Task 2 root-aware storage and Task 3 workspace guard
- Produces: continuous audit inventory and idempotent crash replay for claims and repair mutexes

- [ ] **Step 1: Port doctor tests only and capture RED**

```bash
node --test prototype/integrated/tests/tools/agent_comms/{claims-recovery-replay,status-recovery-audits}.test.mjs
```

Expected: audit-published/pre-mutation cases are not replayed or incomplete recovery artifacts are ignored.

- [ ] **Step 2: Port audit modules with explicit roots**

Port `claims-audit.mjs` and `recovery-audits.mjs`. Every read call uses:

```js
readJsonRegularNoFollow(file, validateAudit, context.paths.root, injectedOpen)
```

Every directory inventory uses:

```js
listJsonFiles(directory, { root: context.paths.root, readDirectory });
```

- [ ] **Step 3: Implement replay contract**

An audit with the exact still-active source generation and absent destination is pending and replayable. A replacement generation, mismatched bytes, orphan target, or conflicting destination is corrupt and blocks repair.

- [ ] **Step 4: Demonstrate two-repairer liveness**

Temporarily neutralize the final generation check in the test mutation seam. Run the focused race and retain the expected failure proving a replacement generation can be harmed. Restore production and rerun green.

- [ ] **Step 5: Run focused and full GREEN**

```bash
node --test prototype/integrated/tests/tools/agent_comms/{claims-recovery-replay,status-recovery-audits,status,repair-mutex,doctor-race}.test.mjs
npm run test:integrated
```

- [ ] **Step 6: Commit**

```bash
git add prototype/integrated
git commit -m "fix: complete integrated recovery audits"
```

---

### Task 5: Port canonical prompt hardening

**Files:**
- Modify: paths listed by `migration/patches/0001-prompt-and-docs.patch` under `prototype/integrated/`
- Test: `prototype/integrated/tests/tools/agent_comms/prompt.test.mjs`

**Interfaces:**
- Consumes: integrated CLI command names
- Produces: shell-safe prompt with required first-read, identity, task, ownership, and evidence instructions

- [ ] **Step 1: Port prompt tests and capture RED**

```bash
node --test prototype/integrated/tests/tools/agent_comms/prompt.test.mjs
```

Expected: missing required instructions or unsafe interpolation failure.

- [ ] **Step 2: Port minimal prompt behavior**

Preserve CLI-produced values as quoted data. Do not interpolate agent-controlled text into executable shell fragments.

- [ ] **Step 3: Run focused and full GREEN**

```bash
node --test prototype/integrated/tests/tools/agent_comms/prompt.test.mjs
npm run test:integrated
```

- [ ] **Step 4: Commit**

```bash
git add prototype/integrated
git commit -m "fix: complete integrated protocol prompt"
```

---

### Task 6: Certify the combined snapshot

**Files:**
- Create: `prototype/integrated/COMBINED_VERIFICATION.md`
- Create: `prototype/integrated/tests/tools/agent_comms/combined-hardening.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–5
- Produces: certified source snapshot for standalone extraction

- [ ] **Step 1: Add cross-patch regressions**

The focused file must exercise all twelve cases listed in `docs/MIGRATION.md` under “Required combined regressions.” Use real CLI subprocesses for workspace identity and stdout/exit-code assertions; use deterministic injected seams for race windows.

- [ ] **Step 2: Capture RED liveness for each protection group**

For storage, lifecycle, and doctor groups, temporarily neutralize one exact predicate through an injected test seam. Each mutation must fail the intended named tests. Record command, exit, and failure fragment in `COMBINED_VERIFICATION.md`; restore the production predicate immediately.

- [ ] **Step 3: Run final verification**

```bash
find prototype/integrated/tools/agents -name '*.mjs' -print0 | xargs -0 -n1 node --check
npm run test:integrated
git diff --check
find prototype/integrated/tools prototype/integrated/tests -name '*.mjs' -print0 | xargs -0 wc -l | awk '$1 >= 300 { print; failed=1 } END { exit failed }'
```

Expected: syntax green; all tests pass; diff check green; no listed file reaches 300 lines.

- [ ] **Step 4: Record exact evidence**

`COMBINED_VERIFICATION.md` must contain exact HEAD, commands, exit codes, test counts, mutation RED evidence, and remaining limitations. Do not copy historical counts.

- [ ] **Step 5: Commit**

```bash
git add prototype/integrated
git commit -m "test: certify combined protocol hardening"
```
