### Task 10: Live multi-agent acceptance and primary PR

**Files:**

- Modify only if a verified defect is found: files already introduced by Tasks 1–9.
- Create runtime evidence only under ignored `.agents/artifacts/`; do not stage it.

**Interfaces:**

- Validates the public CLI as a user or independent agent will invoke it.
- Produces no committed runtime state and no `.github/workflows/` changes.

- [ ] **Step 1: Run static and focused verification**

```bash
node --check tools/agents/comms.mjs
node --test tests/tools/agent_comms/*.test.mjs
git diff --check main...HEAD
```

Expected: all commands exit `0` and every protocol test file executes.

- [ ] **Step 2: Demonstrate the required live failures through the executable**

Using a fresh temp bus via `PW2_AGENT_BUS_DIR`, demonstrate and retain command/output excerpts for:

1. malformed inbox JSON → `doctor` exit `4`;
2. overlapping claim by a second agent → `claim` exit `5`;
3. required watcher older than 45 seconds → `doctor --require-live visual` exit `6`;
4. handoff without verification evidence → `handoff` exit `4`.

Remove only the exact temporary fixture after each demonstration. Do not mutate source to fake a RED.

- [ ] **Step 3: Run cross-worktree live acceptance**

Initialize the real ignored bus once, then invoke the branch CLI with `cwd` in the main checkout and in this linked worktree. Register `orchestrator-probe`, `visual-probe`, `models-probe`, and `physics-probe` with distinct tasks and ownership scopes. Start watchers for all four and verify `status --json` reports them online.

Send a `contract_request` from `visual-probe` to `models-probe`, observe one watcher JSONL event, reply from `models-probe`, acknowledge the request, and verify the sender-visible acknowledgement. Claim `game/presentation` as `visual-probe`, prove `models-probe` cannot claim `game/presentation/camera`, then release it. Create a committed-form handoff with a real branch/base SHA and passing verification summary. Stop watchers, close all four probe identities, and verify their status is offline with no active claims.

- [ ] **Step 4: Verify existing project gates remain green**

```bash
gdformat --check game/ tests/ content/
gdlint game/ tests/ content/
./tools/ci/check_gdscript.sh game tests content
./tools/ci/run_tests.sh tests/
./tools/ci/check_sim_invariants.sh game/sim
```

Expected: formatting/lint/static/invariant commands exit `0`; gdUnit wrapper executes every declared suite and case with zero failures.

- [ ] **Step 5: Audit scope, structure, and cleanliness**

```bash
find tools/agents/lib -name '*.mjs' -print0 | xargs -0 wc -l
git diff --name-only main...HEAD
git diff --check main...HEAD
git status --short
```

Expected: every runtime module is below 300 lines; only the file map declared in this plan changed; diff check is clean; task worktree is clean; `.agents/` is absent from tracked and untracked status.

- [ ] **Step 6: Request two-stage review and fix verified findings**

Use `superpowers:requesting-code-review`. First reviewer checks exact conformance to the approved design and this plan. Second reviewer checks implementation quality, race safety, recovery semantics, tests, and documentation. For every accepted finding, reproduce the defect before changing code, add or strengthen a failing test, implement the narrow correction, and rerun the focused plus full protocol suites.

- [ ] **Step 7: Push the primary branch**

```bash
git push -u origin ops/agent-comms-protocol
```

Expected: pre-push gates pass and the branch is published without modifying `main`.

- [ ] **Step 8: Open the primary PR**

Create a PR whose description includes:

- task name `OPS — local agent communication protocol`;
- concise user-facing behavior;
- each acceptance criterion with command evidence;
- protocol-test and existing Godot-suite summaries;
- the four demonstrated RED failures and their exit codes;
- cross-worktree live acceptance result;
- statement that `.agents/` contains local plaintext transport state and is ignored;
- explicit note that CI wiring is deferred to the required post-merge shared-file micro-PR.

End the handoff with the PR link. Do not merge it.

---

## Post-Merge Follow-up Boundary

After the user merges the primary PR, create a new branch and new plan for one shared-file micro-PR that modifies only `.github/workflows/ci.yml` (and a directly necessary CI test script if the existing workflow cannot count Node tests reliably). Its gate must invoke `node --test tests/tools/agent_comms/*.test.mjs`, prove a deliberately failing Node test makes CI non-zero, and leave all existing Godot checks intact. Do not begin that micro-PR from this branch.
