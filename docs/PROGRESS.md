# Progress

Last updated: 2026-08-15

## Current state

The project is at the standalone extraction handoff boundary.

- [x] Original local communication protocol implemented and acceptance-tested inside Papercut Warzone 2.
- [x] Prototype baseline preserved from source commit `9a866cf16f97a0aa1af7ea792acc79bc02278633`.
- [x] Original design, plan, task briefs, and task reports preserved.
- [x] Four uncommitted hardening sets exported as immutable patches with checksums.
- [x] Competitor and native-harness research summarized.
- [x] Standalone product direction documented.
- [x] Core, adapter, and productization execution plans drafted.
- [ ] User explicitly approves the proposed ambient-workspace/workstream model.
- [ ] Hardening patches integrated into one verified prototype snapshot.
- [ ] Papercut assumptions removed behind project-agnostic interfaces.
- [ ] Standalone package layout created.
- [ ] Native Codex adapter implemented.
- [ ] Native Claude Code adapter implemented.
- [ ] Native Gemini CLI adapter implemented.
- [ ] Generic MCP fallback implemented.
- [ ] Installer, public documentation, license, and release automation completed.

## Active gate

Before implementation continues, review the proposed decisions in `docs/DECISIONS.md`. In particular, confirm:

1. every supported session silently attaches to workspace awareness;
2. no session becomes a permanent project-wide orchestrator;
3. workstream coordinators are optional, scoped, and replaceable;
4. `Intent` is first-class and tasks remain optional;
5. the first product release does not launch or own agent processes.

## Next implementation action

After approval, execute `docs/superpowers/plans/2026-08-15-acc-prototype-reconciliation.md` from Task 1. The first deliverable is one integrated prototype snapshot with all four hardening sets reconciled and verified together.

Then execute the core extraction plan. Do not start native adapters before the project-agnostic core passes its complete regression suite.

## Historical verification evidence

The imported baseline previously passed 181 protocol tests. Separate hardening branches reported:

- lifecycle/CLI: 192 tests;
- storage/messages: 203 tests;
- doctor/recovery: 196 tests;
- full Papercut post-rebase acceptance: 63/63 gdUnit suites and 464/464 cases.

These counts are historical evidence, not certification of the combined standalone tree. Re-run all gates after integration.

The imported baseline was also verified in the transfer staging tree. One focused SIGTERM run and one complete serial run passed, while later focused, serial, and parallel runs exposed a pre-existing timing flaw: the test sends SIGTERM after a fixed 80 ms and can terminate the child before its handler is ready. The fresh full run in the target repository was 180/181 with only `null !== 0` in that test. All 49 archived blobs match source commit `9a866cf` exactly, so this is preserved source behavior rather than transfer corruption. The immutable archive was not edited; the reconciliation plan must replace the arbitrary delay with a condition-based readiness signal and demonstrate this RED.
