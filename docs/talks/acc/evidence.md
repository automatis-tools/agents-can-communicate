# Evidence map

Content baseline: main commit `8bfb53f3` (2026-10-12), package 0.11.1. The speaking kit adds
no runtime capability. Do not interpret a release-candidate record as publication proof.

| Claim / slide | Current source or retained evidence | What it establishes |
|---|---|---|
| Independent peers, local explicit messages, 1–3 | `README.md`, `docs/CONCEPTS.md` | Current product contract, with native support limits |
| Durable record before delivery, 4–6 | `packages/core/src/conversations.mjs`, `packages/delivery-router/src/router.mjs`, `docs/ARCHITECTURE.md` | Commit and offer ordering, retry and fallback semantics |
| Receipt definitions, 5 | `docs/CONCEPTS.md`, `packages/core/src/receipts.mjs` | Separate transport acceptance, retrieval and acknowledgement |
| Ownership and generations, 7 | `packages/core/src/sessions.mjs`, `docs/SECURITY_MODEL.md` | Old generations cannot mutate replacement ownership |
| Leased claims, 8 | `packages/core/src/claims.mjs`, `packages/core/test/batch-claims.test.mjs`, `tests/process/concurrent-claim.test.mjs` | Advisory default, atomic conflict, real process contention |
| Capability/reachability/consent, 9 | `docs/CAPABILITIES.md`, adapter `COMPATIBILITY.md` and shipped fixtures | Exact captured client behavior, distinct from current activation |
| Untrusted peer content, 10 | `docs/SECURITY_MODEL.md`, `tests/security/peer-injection.test.mjs` | Attributed data and escaped rendering, not model isolation |
| Fail-open hooks, 11 | `AGENTS.md`, `docs/HOW_IT_WORKS.md`, hook-runner timeout tests | Coordination failure must not block coding sessions |
| Hook-cost measurements, 12–13 | `docs/release-evidence/unreleased-hook-read-cost.md` | Historical alternating measurements on a copied real data home |
| Native capture boundaries, 14 | `docs/release-evidence/v0.11.1.md`, `docs/CAPABILITIES.md` | Real clients and model stub in package checks, not a live-provider productivity experiment |
| Scope and caveats, 15 | `docs/SECURITY_MODEL.md`, `docs/CAPABILITIES.md` | One machine/OS user, no transcript collection, opt-in acceleration |

## Historical performance fact used in the deck

The development record compares main `d052ebbd` with the hook-read fix, three alternating
rounds at load average 10–27, macOS, Node 26.5.1. Values are per-turn wall-clock ranges:

| Copied workspace | Before | After |
|---|---|---|
| ACC, 4,760 files, 57 sessions | 0.96–1.05 s | 0.29–0.33 s |
| newsmill-ai, 6,432 files, 103 sessions | 1.10–1.30 s | 0.30–0.34 s |
| CodexBar ClaudeProbe, 15,921 files, 2,234 sessions | 3.21–3.80 s | 0.39–0.41 s |

These are retained development measurements, not fresh benchmarks of this presentation,
typical user latency, a productivity estimate, or a claim that cost is now constant.
A turn still reads every message and receipt once. Use the original record for provenance.

## Speaking-kit checks

The replay's assertions cover its own observable CLI behavior. A duplicate-send mutation
must make the idempotency assertion fail. That mutation checks this replay's ability to
reject duplicate-message evidence, not the entire product's idempotency implementation.
The production suite already has dedicated idempotency and real-client acceptance gates.

Save current command results and visual checks in a separate temporary evidence archive.
The replay does not use real Codex/Claude sessions, reach native inbox sockets, or invoke
models. A stage-machine native rehearsal remains necessary before promising live behavior.

No stars, user counts, time-saved percentages, model accuracy or adoption claims appear in
the talk. The proposed attendee experiment is a request for qualitative technical feedback,
not a claim of measured effectiveness.
