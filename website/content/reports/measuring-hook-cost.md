---
id: "measuring-hook-cost"
title: "Measure hook cost without changing the job"
description: "A measurement protocol for ACC hooks: isolate workload axes, preserve durability and semantics, alternate candidates, and distinguish local timing from client evidence."
route: "/reports/measuring-hook-cost/"
type: "report"
order: 20
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "measurement-method"
---

# Measure hook cost without changing the job

A coordination hook runs around work the user actually wants to do. Its overhead matters, but making a hook faster by removing useful work proves little about a better implementation.

This report describes the measurement protocol used to evaluate changes. It contains no new speedup claim, production latency estimate, or client certification.

## Name the operation

Begin with the behavior that must remain correct. An inbox read should return the intended message and advance only the appropriate recipient's receipt. A writer should actually commit. An attention check needs meaningful obligations, not an empty fixture that always produces an empty result.

Keep fixture preparation and protocol validation outside the timed operation. Check correctness alongside timing.

## Vary one workload dimension

A workspace's message count, recipient fanout, journal size, and concurrent activity can impose different costs.

For example, returning one message does not establish bounded I/O. The implementation might still enumerate a growing event directory or scan every receipt before selecting that message.

Hold other dimensions stable while measuring the chosen axis. A changed algorithm and a changed fixture are two changes, even when they land in one patch.

## Compare under recorded conditions

Keep the runtime, machine, scenario, execution policy, and relevant tool versions consistent. Record the source revisions and the actual probe used.

Alternate baseline and candidate runs so that a warming machine or changing background load is less likely to look like an improvement. Repeated runs of the same revision help reveal noise; they are not evidence of a refactoring benefit.

Collect diagnostic traces separately when instrumentation changes the cost of the operation.

## Preserve the useful guarantees

Do not disable durability, safety checks, or required protocol work to improve a headline time.

Local test environments may deliberately use a different filesystem-flush policy from production. Record that condition. A number from that policy cannot silently become an estimate for a real user's installed hook.

Likewise, a microbenchmark isolates one operation. The installed client's complete hook path includes process startup, integration, and the surrounding environment.

## Report what the run establishes

A useful result names the source, workload, conditions, correctness checks, samples, and uncertainty. Failed or interrupted runs remain evidence of those outcomes.

Static complexity findings can suggest where to investigate. They do not establish that a particular path dominates an installed client's latency.

The next step after a promising measurement is a focused product change, a mutation control for its contract, and the normal complete gates. A performance report should remain tied to the job the hook still performs.

## Sources

- [Hook-cost investigation](https://github.com/automatis-tools/agents-can-communicate/issues/310)
- [Architecture and hook boundary](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/ARCHITECTURE.md)
- [Verification requirements](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/AGENTS.md)
