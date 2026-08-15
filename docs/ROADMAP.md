# Execution roadmap

The plans are intentionally separated so each phase produces independently reviewable software.

## Phase 0 — Reconcile preserved hardening

Plan: `docs/superpowers/plans/2026-08-15-acc-prototype-reconciliation.md`

Outcome: one combined, fully green prototype snapshot containing storage, lifecycle, doctor/recovery, and prompt hardening. No standalone semantic changes yet.

## Phase 1 — Extract project-agnostic core

Plan: `docs/superpowers/plans/2026-08-15-acc-core-extraction.md`

Outcome: package-shaped protocol, core, filesystem storage adapter, Workspace discovery, Intent, Workstream, Task, Claim, communication, sync, status, doctor, and CLI. Git and vendor integrations remain optional ports.

## Phase 2 — Add cross-vendor adapters

Plan: `docs/superpowers/plans/2026-08-15-acc-adapters.md`

Outcome: generic MCP plus native Codex, Claude Code, and Gemini CLI integrations with exact capability matrices and real cross-vendor acceptance.

## Phase 3 — Productize

Plan: `docs/superpowers/plans/2026-08-15-acc-productization.md`

Outcome: installer, optional project config, public docs, threat model, CI, npm tarball, and an unpublished release candidate ready for explicit publication approval.

## Gates between phases

Do not overlap phases merely because different agents are available.

- Phase 0 → 1: combined prototype suite and mutation liveness green.
- Phase 1 → 2: project-agnostic token scan clean; non-Git core acceptance green.
- Phase 2 → 3: real Codex/Claude/Gemini acceptance and capability matrix complete.
- Phase 3 → release: user reviews UX, security limitations, package contents, and explicitly authorizes publication.
