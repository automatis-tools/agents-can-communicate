# Agent-led documentation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make ACC's public documentation inviting and understandable, from the approved README through everyday use and technical reference, and deliver the changes in PR #112 for maintainer review.

**Architecture:** Keep existing public file paths and separate the reader's first experience from the agent/operator reference. Explain ordinary tasks, agent-led discovery and coordination first; put exact command, protocol, and capability contracts in their reference homes. This is a documentation and documentation-test change, not a new runtime feature.

**Tech Stack:** Markdown, existing Node.js ESM `node:test` gates, installed npm artifact; no new dependencies.

**Spec:** The user-approved working-tree `README.md` at the start of this plan, especially “Open your agents. Let them coordinate.” The user explicitly rejected examples requiring a developer to tell an agent which peer to ask; ordinary task prompts and agents deciding their own conversations are the binding editorial direction.

## Global Constraints

- The user gives ordinary tasks. Supported integrations provide peer awareness and coordination instructions; agents decide whether and how to coordinate. No normal onboarding step asks the user to route peer messages or invoke ACC communication commands.
- Preserve the approved README positioning, the independent-session/subagent analogy, and the explicitly illustrative dialogue. Do not promise that every agent will coordinate on every task.
- Keep platform, client-version, policy, and delivery limitations accurate. Next-normal-turn delivery is not idle wake-up. Claude's optional native live delivery is off by default and may spend tokens; the vendor development-channel warning remains a startup step. Codex native live delivery is withdrawn.
- Local means the same machine and OS user. Git is optional; worktrees share a workspace. ACC runtime state is outside repositories, and ACC never collects or shares raw transcripts. Optional user-requested workspace configuration is distinct from runtime state.
- Receipts are `queued -> offered -> retrieved -> acknowledged`; transport acceptance is not model attention, and a reply is not proof of task completion. Peer messages remain untrusted input.
- Preserve technical guarantees, working links, complete CLI coverage, adapter evidence and skill behavior. Do not rewrite archived plans, historical release records, or captured fixtures into current claims.
- No runtime behavior changes, new dependencies, package publishing, tagging, or merging. Commit focused changes in this worktree; the controller will fast-forward the clean requested branch and update existing PR #112 after validation.
- Every new or corrected test must fail on a concrete mutation of the defect it protects, then pass after restoration. Record exact commands and results. Do not hide old copy in comments or replace behavior checks with snapshots of marketing prose.
- Full validation and a freshly verified clean candidate record are required before push. During documentation edits the existing recorded-candidate gate is expected to report stale packed content; it must not be disabled and must pass after Task 3.

## File responsibilities

The README sells the workflow; the docs index chooses the next action; getting started gets two sessions working. Why/How/Concepts explain value and mechanics at increasing depth. Capabilities and troubleshooting answer what will happen on the reader's client. CLI/MCP/configuration/protocol/architecture/security/adapter authoring remain precision references. Examples demonstrate normal projects, not additional ACC training for the user. Internal plans and release evidence are contributor material, not onboarding prerequisites.

### Task 1: Carry the approved story through the user journey

**Files:**
- Modify: `README.md`, `docs/index.md`, `docs/GETTING_STARTED.md`, `docs/WHY_ACC.md`, `docs/HOW_IT_WORKS.md`, `docs/CONCEPTS.md`, `docs/CAPABILITIES.md`, `docs/TROUBLESHOOTING.md`.
- Modify: `examples/three-workstreams.md`, `examples/non-git-research.md`.
- Modify tests: `tests/docs/commands.test.mjs`, `tests/docs/addresses.test.mjs`; a focused new `tests/docs/onboarding.test.mjs` is allowed if it keeps responsibilities clearer.

**Interfaces:**
- Consumes: approved README, shipped hook/context projection and installed adapter skills, existing certification/compatibility records and CLI command parser.
- Produces: public narrative and navigation at the same paths; technical references keep their existing paths. Preserve `CONCEPTS.md#intent-is-awareness-a-claim-commits` or update all incoming links. Link repo-only examples with repository URLs so installed-package links stay valid.

- [ ] Read the affected pages, doc tests, and relevant implementation/capability evidence. Map each page to one reader question. Preserve useful detail by linking its canonical reference, not by leaving repetitive essays.
- [ ] Replace the two README assertions that pin obsolete marketing sentences with useful documentation contracts. Keep checks for removed commands, exact receipt distinctions, complete CLI command coverage, marked executable examples and adapter terms. Replace the getting-started requirement for agent commands with installation, ordinary task prompts, observable coordination, delivery limits, diagnostics, and uninstall navigation; avoid exact approved slogans as required bytes.
- [ ] Expand the recipient-address gate to `examples/*.md`. Run `node --test tests/docs/addresses.test.mjs` before fixing the existing `--to review` example; it must fail naming the unresolved address. Also demonstrate the revised onboarding check rejecting a specific missing required setup or capability boundary, then restore it. Record actual evidence in the task report.
- [ ] Rewrite the user pages in clear English, using the approved README's voice. The first journey is install, restart supported clients, give ordinary related tasks, observe peers discover dependencies and exchange information when useful. Distinguish observation from guaranteed model behavior; do not make a human request “use ACC”, “check your inbox”, or “ask Claude” the normal happy path.
- [ ] Keep user setup/diagnostic shell commands distinct from commands agents run. Explain same-client addressing ambiguity only where useful to the reference reader. Examples must have coherent participants and dependencies; non-Git examples must not imply remote users share local storage. Do not claim all worktree files are shared or all claims enforceable.
- [ ] Verify with `node --test tests/docs/commands.test.mjs tests/docs/addresses.test.mjs tests/docs/executable.test.mjs tests/docs/skills.test.mjs tests/docs/diagrams.test.mjs tests/acceptance/package-links.test.mjs`. If adding onboarding tests, include that file. Run `git diff --check` and the full `npm test` once, reporting any stale-candidate failure explicitly rather than claiming a green suite.
- [ ] Self-review every listed page for purpose, factual honesty, density and links. Commit only this task's files with `docs: explain the workflow through agent-led coordination`. Write report with tests, mutation evidence, files, commit and concerns.

### Task 2: Make the reference consistent and easier to use

**Files:**
- Modify: `docs/CLI.md`, `docs/MCP.md`, `docs/CONFIGURATION.md`, `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_MODEL.md`, `docs/ADAPTER_AUTHORING.md`, `docs/DESIGN_DECISIONS.md`, `docs/GLOSSARY.md`, `docs/RELEASING.md`, `SECURITY.md`, `AGENTS.md`.
- Inspect (change only for a concrete contradiction introduced or exposed by this task): `tests/docs/*.test.mjs`, `tests/process/surface-coverage.test.mjs`, `tests/process/session-resolution.test.mjs`, package `COMPATIBILITY.md` and installed skills. Captured fixtures must remain untouched.

**Interfaces:**
- Consumes: Task 1's public navigation, onboarding and narrative; actual runtime schemas/parser/configuration/capability evidence.
- Produces: precise, scannable reference at unchanged file paths and an accurate contributor entry point. No new exported API or CLI command.

- [ ] Read every listed reference and verify the concrete source contracts before changing assertions. CLI should group human install/diagnostic tasks separately from the agent communication vocabulary and retain all commands/flags/exit codes. MCP should identify its polling/manual-integration boundary without implying an absent automatic adapter.
- [ ] Rewrite or refine each listed page for its own audience. Use concise introductions, task-oriented headings, compact tables only for repeated mappings, and links instead of repeated onboarding. Keep normative technical detail. Preserve test-required technical headings/contract distinctions where still appropriate; do not retain meaningless prose solely to appease an old copy snapshot.
- [ ] Correct facts found in the audit: same-machine/user storage rather than remote collaboration through matching ids; optional config writes versus external runtime state; session-id default addressing versus explicitly stable participant identity after a new conversation; current Claude live evidence versus historical failed captures; exact-version normal-turn/guard evidence versus minimum-plus-probe Claude live support; no current coordinator/workstream/task subsystem; current truthful receipt names in AGENTS.
- [ ] Make release instructions fit current package version and the clean candidate/evidence two-commit procedure, using existing scripts. Clearly distinguish historical authentication observations from universal current npm claims. Preserve authorization boundaries; do not actually publish, tag, configure credentials, or change security policy.
- [ ] If a test needs correction, show its new assertion failing on the exact targeted documentation mutation, restore it, then record passing output. If no test changes are necessary, report that plainly.
- [ ] Run `node --test tests/docs/commands.test.mjs tests/docs/addresses.test.mjs tests/docs/executable.test.mjs tests/docs/skills.test.mjs tests/docs/diagrams.test.mjs tests/process/surface-coverage.test.mjs tests/process/session-resolution.test.mjs tests/acceptance/package-links.test.mjs`, `git diff --check`, and the full `npm test` once. The stale candidate remains an expected unresolved finalization step, never a skipped gate.
- [ ] Self-review the complete file list and commit with `docs: align reference guides with the independent-agent workflow`. Write report with source-backed corrections, tests, mutation evidence if any, commit and concerns.

### Task 3: Record the verified candidate and validate the complete change

**Files:**
- Modify: `CHANGELOG.md` (only the current Unreleased narrative and its candidate table).
- No packed file changes unless a concrete validation defect is escalated first.

**Interfaces:**
- Consumes: all reviewed documentation commits; existing `scripts/verify-package.mjs`, `scripts/git-provenance.mjs` and `tests/acceptance/recorded-candidate.test.mjs`.
- Produces: a truthful clean-commit artifact record, passing final validation and a short evidence report for PR review.

- [ ] Read the current changelog and candidate test. Update Unreleased to describe the actual final approved documentation; replace the superseded claims about manually asking agents to communicate and the obsolete README layout. Preserve unrelated unreleased changes and all published release history.
- [ ] Commit that narrative-only change, confirm `git status --porcelain` is empty, and record full HEAD. Create an isolated artifact directory with `mktemp -d /private/tmp/acc-docs-candidate.XXXXXX`. Use the isolated npm cache for all package operations.
- [ ] Run `npm run check`, pack with `npm pack --pack-destination <resolved-artifact-directory> --json`, then `node scripts/verify-package.mjs <resolved-tarball-path>`. Record filename, byte size, entry count, sha256, platform and clean built-from commit from actual outputs, not estimates.
- [ ] Change only the Unreleased candidate table to those observed values and commit with `docs: record the verified documentation candidate`. Do not update historical published evidence.
- [ ] Run `npm run check`, `npm test`, `node scripts/verify-package.mjs <resolved-tarball-path>` and `git diff --check`. All required checks must pass. Installed artifact verification proves packaging/command flow, not spontaneous real-model coordination; say so in the evidence.
- [ ] Self-review the changelog diff and report commits, exact tests/results, artifact path and any limitations. Do not push: the controller performs final independent review and then updates the already-authorized PR.
