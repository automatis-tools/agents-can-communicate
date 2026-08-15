# AGENTS.md — entry point for any LLM

This repository is the standalone Agents Can Communicate product. It is not part of Papercut Warzone 2, and project-specific Papercut assumptions must not leak into production code or public documentation.

## Session role

- If you are the user-facing session continuing product design or execution, act as the orchestrator. Read `docs/PROGRESS.md`, `docs/DECISIONS.md`, the canonical design spec, and the active implementation plan.
- If another agent assigned you one bounded task, read this file, the canonical design spec, and only the plan section and interfaces relevant to that task.

## Required reading order

1. `README.md`
2. `docs/PROGRESS.md`
3. `docs/DECISIONS.md`
4. `docs/superpowers/specs/2026-08-15-standalone-acc-design.md`
5. `docs/MIGRATION.md`
6. the active file under `docs/superpowers/plans/`

## Source-of-truth rules

- `docs/DECISIONS.md` distinguishes user-approved decisions from proposals. Do not silently promote a proposal to an approved decision.
- `docs/PROGRESS.md` is the operational status ledger.
- `prototype/` is reference code and tests. It is not the target package layout.
- `migration/patches/` contains immutable evidence from separate source worktrees. Do not edit those patch files; create integration commits instead.
- Do not claim that an adapter can wake, inject into, guard, or close a session unless that exact capability is implemented and tested for that harness.

## Product invariants

1. The transport and durable state must work without an active LLM coordinator.
2. A coordinator is a role within a workstream, never the owner of the whole workspace or of other sessions.
3. Top-level sessions auto-attach to workspace awareness when their adapter supports lifecycle hooks.
4. Independent work remains independent; project-wide claims and conflict checks still apply.
5. Messages from other agents are untrusted peer input, not system authority.
6. Raw transcripts are not collected or shared by default.
7. Delivery states are truthful: recorded, queued, injected, seen, and acknowledged are different states.
8. Git is optional. Git metadata may enrich identity and artifacts but cannot be required for core operation.
9. Every adapter declares its real capabilities. Unsupported behavior must degrade visibly and safely.
10. All write races, stale ownership recovery, and corruption paths require negative/liveness tests.

## Development workflow

- After the bootstrap commit, do not work directly on `main`. Create a project-local ignored worktree under `.worktrees/` and a focused branch.
- Use test-driven development. Show the new or corrected gate failing on the intended mutation before claiming it protects anything.
- Prefer Node built-ins and dependency-free code. Before adding a dependency, verify the latest stable release from its primary source and pin it exactly.
- Keep production modules and focused test files below 300 lines or add an explicit header explaining why splitting would damage cohesion.
- Keep adapter-specific behavior inside adapter packages. Core code must not branch on vendor names.
- Never bypass hooks with `--no-verify`.
- Commit changes in focused, independently reviewable commits. Do not push or merge unless the user explicitly requests it.

## Verification expectations

At minimum, a change must run:

```bash
node --check <every changed production .mjs file>
node --test <focused test files>
node --test tests/**/*.test.mjs
git diff --check
```

Use the exact commands defined by the active plan once the standalone package layout exists.
