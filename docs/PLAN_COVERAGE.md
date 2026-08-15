# Plan self-review

Review date: 2026-08-15

## Spec coverage

| Design requirement | Plan coverage |
|---|---|
| Preserve and reconcile four hardening sets | Prototype reconciliation Tasks 1–6 |
| Strict protocol, IDs, errors, versions | Core extraction Tasks 2–3 |
| Storage transaction boundary and recovery | Reconciliation Tasks 2–4; core extraction Task 4 |
| Optional Git and non-Git Workspace discovery | Core extraction Task 5 |
| Participant, Session, and first-class Intent | Core extraction Task 6 |
| Optional Workstream coordinator | Core extraction Task 7 |
| Task graph and dependencies | Core extraction Task 7 |
| Workspace-global generic claims | Core extraction Task 7 |
| Messages, decisions, artifacts, handoffs | Core extraction Task 8 |
| Cursor sync and compact attention | Core extraction Task 8; adapter plan Task 1 |
| Generic MCP fallback | Adapter plan Task 2 |
| Codex native integration | Adapter plan Task 3 |
| Claude Code native integration | Adapter plan Task 4 |
| Gemini CLI native integration | Adapter plan Task 5 |
| Real cross-vendor and non-Git acceptance | Adapter plan Task 6 |
| Optional committed project config | Productization Task 2 |
| Automatic reversible installer and doctor | Productization Task 3 |
| Public docs and adapter-author guide | Productization Task 4 |
| Threat model and security suite | Productization Task 5 |
| CI, tarball inspection, unpublished release candidate | Productization Task 6 |

## Placeholder scan

The plans contain none of the placeholder patterns prohibited by the writing-plans skill. Actions that depend on current external state specify the authoritative source and the exact evidence to record.

## Interface consistency

- Workspace, Session, Intent, Workstream, Task, Claim, Message, Decision, Artifact, Handoff, Event, Snapshot, EventPage, and AttentionItem names match the canonical design and protocol documents.
- Storage root-aware helper signatures from migration are repeated exactly in the reconciliation plan.
- Adapter capability names match `docs/ADAPTERS.md` and the adapter plan.
- Model-facing operations remain `sync`, `work`, `claim`, `message`, `task`, and `finish` across architecture, protocol, adapters, and plans.
- Human-only operations remain `status`, `doctor`, `install`, `uninstall`, and configuration commands.

## Remaining approval gate

The plans are executable only after the user confirms the proposals listed in `docs/DECISIONS.md`. Phase 0 preservation/reconciliation can proceed without selecting the future transactional backend, package name, license, or remote architecture.
