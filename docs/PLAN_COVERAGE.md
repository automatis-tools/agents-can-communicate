# Plan self-review

Review date: 2026-08-15

Revised 2026-08-15 after a plan audit: the core extraction plan gained Task 5 (filesystem storage adapter and recovery extraction, previously missing despite the package manifest existing since Task 1), later extraction tasks were renumbered 6–9, and the reconciliation plan's command errors were corrected.

A second, deeper audit on the same date grounded the plans in the prototype code: the extraction plan now designs the event log explicitly (ported writer mutex, write-ahead journal generalized from the claims-audit pattern, sequence-ordered event files, crash-window replay), adds presence classification and claim lease/force-release semantics, and the adapter plan gained session-binding persistence, injection-safe peer rendering in the shared projector, and MCP client session identity.

## Spec coverage

| Design requirement | Plan coverage |
|---|---|
| Preserve and reconcile four hardening sets | Prototype reconciliation Tasks 1–6 |
| Strict protocol, IDs, errors, versions | Core extraction Tasks 2–3 |
| Storage transaction boundary and recovery | Reconciliation Tasks 2–4; core extraction Tasks 4–5 |
| Hardened filesystem backend extracted behind `CoordinationStore` | Core extraction Task 5 |
| Standalone `status`/`doctor` surface | Core extraction Tasks 5 and 9; productization Task 3 |
| Optional Git and non-Git Workspace discovery | Core extraction Task 6 |
| Participant, Session, and first-class Intent | Core extraction Task 7 |
| Optional Workstream coordinator | Core extraction Task 8 |
| Task graph and dependencies | Core extraction Task 8 |
| Workspace-global generic claims | Core extraction Task 8 |
| Messages, decisions, artifacts, handoffs | Core extraction Task 9 |
| Cursor sync and compact attention | Core extraction Task 9; adapter plan Task 1 |
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
| Claim leases, stale owners, and audited force release | Core extraction Task 8; `docs/PROTOCOL.md` |
| Presence freshness for hook-only adapters | Core extraction Task 7; `docs/ARCHITECTURE.md` |
| Session binding across ephemeral hook processes | Adapter plan Task 1 |
| MCP client session identity with truthful capabilities | Adapter plan Task 2 |
| A2A-mappable vocabulary (spec §11) | Core extraction Task 3 |
| Lazy workspace materialization | Core extraction Tasks 6–7; `docs/ARCHITECTURE.md` |
| Peer equality: any session answers for the whole Workspace | Core extraction Task 9 (full-scope sync); adapter plan global skill constraint; `docs/VISION.md`, `docs/PROTOCOL.md` |
| Solo zero-overhead and kick-off on the second session | Core extraction Task 9 (empty solo projection); adapter plan Task 1 and global constraint; `docs/UX.md`, spec §5.3–5.4 |

## Placeholder scan

The plans contain none of the placeholder patterns prohibited by the writing-plans skill. Actions that depend on current external state specify the authoritative source and the exact evidence to record.

## Interface consistency

- Workspace, Session, Intent, Workstream, Task, Claim, Message, Decision, Artifact, Handoff, Event, Snapshot, EventPage, and AttentionItem names match the canonical design and protocol documents.
- Storage root-aware helper signatures from migration are repeated exactly in the reconciliation plan.
- Adapter capability names match `docs/ADAPTERS.md` and the adapter plan.
- Model-facing operations remain `sync`, `work`, `claim`, `message`, `task`, and `finish` across architecture, protocol, adapters, and plans.
- Human-only operations remain `status`, `doctor`, `install`, `uninstall`, and configuration commands; `attach`, `heartbeat`, and `detach` are adapter-facing lifecycle commands and are not advertised as model tools.

## Approval gate status

The ambient-model gate closed on 2026-08-15 (see `docs/DECISIONS.md`). Phase 0 reconciliation can proceed. The future transactional backend, package name, license, remote architecture, and claim lease defaults remain open and do not block it.
