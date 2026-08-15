# SDD ledger — plan: docs/superpowers/plans/2026-08-14-agent-communication-protocol.md

Execution mode: subagent-driven development
Branch: ops/agent-comms-protocol
Plan commit: 343d65b
Pre-flight plan conflict scan: clean

Task 1: fix round 1/5 (2 addressed, 0 open — exact `..` escape; handoff evidence/readiness consistency; commits 458b83c..d1cd54a)
Task 1: complete (commits 343d65b..d1cd54a, review clean)

Task 2: fix round 1/5 (implementation correct, 1 open — missing stale/offline presence-independence regression; commits 944f7e9..05c612f)
Task 2: fix round 2/5 (1 addressed, 0 open — stale/offline open-registry lookup covered; commits 05c612f..d47052f)
Task 2: complete (commits d1cd54a..d47052f, review clean)

Task 3: minor (deferred): attachment size and digest use separate stat/stream opens, allowing a concurrent replacement race; final review must triage.
Task 3: fix round 1/5 (3 addressed, 1 implementation-addressed/test-open — durable attachment verification; persisted seen; strict bound receipts; artifact classification; commits 8f48df9..28820fa)
Task 3: fix round 2/5 (2 addressed, 0 open — recipient-branch liveness and test-file structure; commits 28820fa..3d737cc)
Task 3: fix round 3/5 (1 addressed, 0 open — idempotent valid seen receipt under watcher/inbox race; commits 2ea32e4..f8d672d)
Task 3: cannot-verify resolved downstream: sender-visible acknowledgement is explicitly exercised by Task 7 status and Task 10 live acceptance.
Task 3: complete (commits d47052f..f8d672d, review clean; 1 deferred minor)
Task 4: minor (deferred): default output interleaves BEL into subsequent JSONL; Task 8 runtime output wiring/final review must route bell without corrupting JSONL.
Task 4: fix round 1/5 (3 addressed, 1 new open — atomic ownership/scan priority/early heartbeat fixed; short guard liveness defect introduced; commits 2ea32e4..f925e7f)
Task 4: fix round 2/5 (original guard finding changed form, 1 open — lifetime owner added but auto-recovery/token TOCTOU remained; commits f925e7f..bacc00c)
Task 4: fix round 3/5 (1 addressed, 0 open — fail-closed stale ownership and agent-id/path binding; commits bacc00c..0429973)
Task 4: complete (commits 3d737cc..0429973, review clean; 1 deferred minor)
Task 5: fix round 1/5 (3 addressed, 0 open — repair TOCTOU, trailing-slash canonicalization, partial owner cleanup; commits b5ce4cc..513c1d5)
Task 5: complete (commits 0429973..513c1d5, review clean)
Task 6: complete (commits 513c1d5..505c7a7, review clean)
Task 7: fix round 1/5 (9 addressed, 0 open — quarantine/archive races, protocol fail-closed, liveness, claim/audit binding; commits 8f85e76..ed61d00)
Task 7: fix round 2/5 (6 addressed, 0 open — crash-recoverable repair mutexes, authoritative claims, schema/audit/archive hardening; commits ed61d00..4e32970)
Task 7: fix round 3/5 (4 addressed, 0 open — direct ENOENT validation, blocking mutex paths, mutex-audit inventory, no-follow reads; commits 4e32970..1b95894)
Task 7: fix round 4/5 (3 addressed, 0 open — exhaustive repair-storage inventory, strict archive destination reads, corrupt-mutex enforcement; commits 1b95894..d08da3e)
Task 8: complete (strict CLI parser and executable dispatch; black-box subprocess coverage for all v1 commands and exits 0/2/3/4/5/6; review and verification recorded in task-8-report.md)
Task 8: fix round 1 complete (explicit body sources never consume open stdin; signal latch stops a watcher published after SIGINT/SIGTERM; human-output and force-stale subprocess coverage added; commit 73e72c2..083a4bb)
Task 9: complete pending commit (canonical prompt/guide, literal NUL-safe renderer and prompt command, scoped AGENTS bootstrap, ignored runtime bus; RED/GREEN and full-suite verification in task-9-report.md; main-worktree ignore proof limited by Git outside-worktree rejection)
Task 9: fix round 1 pending commit (prompt rejects zero/empty ownership with usage 2; operator handoff/ack grammar made executable; exact claim-before-edit and post-merge main ignore proof documented; 180 protocol tests green)
Task 9: fix round 2 pending commit (every repeated prompt ownership must contain non-whitespace content; mixed/order/whitespace parser and subprocess regression coverage; full verification pending)
Task 9: complete (commits a13807e..cf8e217; canonical docs/bootstrap/ignore and strict prompt CLI complete; 181 protocol tests green)

Task 10: Steps 1–5 live acceptance complete (`DONE_WITH_CONCERNS`; no source defect and no implementation change; report in task-10-report.md)
Task 10: focused protocol verification 181/181; required executable RED exits 4/5/6/4; four-probe cross-worktree lifecycle, sender-visible acknowledgement, claim conflict/release, and READY committed handoff verified
Task 10: existing gates green — gdformat 141 files, gdlint, check_gdscript 141 files/78 classes, gdUnit4 56/56 suites and 437/437 cases, sim invariants 20 files; scope/diff/task-worktree cleanliness green
Task 10: concern — pre-merge main does not yet contain this branch's `.agents/` ignore rule and shows the preserved real bus as untracked; initial sandboxed Godot attempt could not open user://logs, exact escalated rerun passed
Task 10: formal two-stage review, push, and PR remain pending with the root orchestrator
Task 10: evidence fix round 1 — four self-contained RED transcripts now include exact CLI command, stdout/stderr, and exits 4/5/6/4; every fresh temp fixture removed
Task 10: evidence fix round 1 — replacement live proof retained raw models watcher stdout with exactly one matching JSONL event; four lifecycle files record start/PID, child-only SIGTERM, watcher exit 0, and ps exit 1; final bus enforcement exit 0
Task 10: evidence fix round 1 — tracked plan execution amendment enumerates eight review-driven runtime support modules and eight regression-test files absent from original literal file bullets; behavioral requirements unchanged
Task 10: evidence fix round 1 — docs-only amendment committed separately as dbc5f576578b6445a7ac286d6cc7dc890eaa2d32; fresh node check, 181/181 protocol tests, diff check, <300-line structure, and clean task-worktree gates passed
Task 10: evidence fix round 1 — READY handoff handoff-20260815T064117.823Z-amendment-r1-review-r1-ccaf7722-b393-4493-94ef-16d41b4c06ef records the new HEAD/base and all 51 actual main...HEAD paths; review-r1 acknowledged it
Task 10: evidence fix round 1 complete — all amendment claims released; coordination watchers exited 0 and their PIDs are absent; all identities offline; final enforcement has no stale/pending/blockers/claims/corrupt; tracked worktree clean
Task 10: evidence fix round 2 — report result reconciled to authoritative DONE at dbc5f576/base d85a6c6; prior observations and evidence-review inconsistencies explicitly resolved
Task 10: evidence fix round 2 — post-commit linked-worktree identities amendment-r2/review-r2 both registered at dbc5f576; READY handoff handoff-20260815T065158.452Z-amendment-r2-review-r2-a5ae38cc-f975-43c0-8f6f-09b41084aedb record commit and emitted message sender_head both equal dbc5f576; all 51 paths present; ack exit 0
Task 10: evidence fix round 2 complete — watcher PIDs 54753/54947 exited 0 and ps checks exited 1; identities offline; final enforcement zero live/stale/pending/claims/blockers/corrupt; no watcher process; no tracked edit or new commit
Task 10: post-rebase recertification — current HEAD 9a866cf16f97a0aa1af7ea792acc79bc02278633 on base bd54f8a11fe414cfa25c851a52fe65afe5233262; no branch-file conflict and no tracked recertification edit
Task 10: post-rebase gates — gdformat 160; gdlint; check_gdscript 160 scripts/90 classes; gdUnit 63/63 suites and 464/464 cases; sim invariants 20; node 181/181; diff/line max299/scope51/status all green
Task 10: post-rebase handoff — READY handoff-20260815T070653.800Z-postrebase-r1-postrebase-review-r1-ad38a61c-fa6b-4b51-9daa-ff1242907f4a has 51 paths; record/attachment/registry/message sender_head all 9a866cf; base bd54f8a; recipient ack exit 0
