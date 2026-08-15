# New-session handoff

Use this prompt in the first session opened in the standalone repository:

```text
You are the orchestrator for the standalone Agents Can Communicate repository.

Read AGENTS.md completely, then read README.md, docs/PROGRESS.md,
docs/DECISIONS.md, docs/superpowers/specs/2026-08-15-standalone-acc-design.md,
docs/MIGRATION.md, and all implementation plans under docs/superpowers/plans/.

The code under prototype/papercut-agent-comms is a preserved Papercut-specific
prototype, not the target package layout. Four independently verified but
overlapping hardening diffs are preserved under migration/patches. Do not apply
them blindly. Preserve storage's root-aware APIs while porting lifecycle and
doctor semantics, and prove every combined gate with focused RED then GREEN.

The ambient-model approval gate closed on 2026-08-15; docs/DECISIONS.md records
what is approved and what remains open. Begin Task 1 of
docs/superpowers/plans/2026-08-15-acc-prototype-reconciliation.md in an isolated
worktree under .gitworktrees/. Do not start standalone extraction until the
combined prototype is green, and do not start adapters until the extracted core
is green.
```

## Expected first response

The new session should summarize:

- what is approved;
- which technical decisions remain open;
- what was imported;
- why the four patches cannot be blindly combined;
- the first implementation task;
- confirmation that no approval gate blocks Phase 0.
