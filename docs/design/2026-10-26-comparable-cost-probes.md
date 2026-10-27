# Comparable cost probes

Date: 2026-10-26. Issue #304, epic #303. The maintainer chose the scope and where timing runs:
- one harness with probes for all three hot paths of the epic: attention computation (#305),
  exact and paged inbox access (#306), and read-only transactions (#307);
- probe validation and negative mutations run in `npm test` on every platform;
- timing comparisons run by hand on one machine, and their raw data and reports are recorded as
  evidence.

## Why

The 2026-10-13 analysis measured ACC 0.11.1, but its probes are gone, and some of them asserted
the cost of the current implementation: the quadratic receipt-filter count, or enumeration of the
whole event directory. A correct optimization would fail such a probe. Its samples (21 attention
calls, 15 history calls) cannot establish p95 or p99, and its hardware provenance is incomplete.
#305-#307 each need a baseline and a candidate measured under the same conditions, with proof
that the candidate still does the useful work.

## What a probe is

A probe is a **scenario**, a **validator** and **observations**:
- The scenario is a deterministic description: sizes, mixes and a seed. Its hash is the SHA-256
  of its canonical JSON. Each side builds its own fixture from the scenario with its own code,
  and records a digest of the primary records that the fixture holds.
- The validator decides from the scenario alone whether an outcome is the useful work, never
  from the implementation's internals. It checks results, fanout, receipt transitions and
  committed or uncommitted work. It never checks traversal counts.
- Observations are what the run measured: wall time, and operation counts. Operation counts
  are diagnostics. They report what the implementation touched, such as primary reads, bytes,
  directory enumerations and receipt visits. They never decide validity.

### Attention (#305)

- Scenario: `ownRequests` sent by the measured participant, each to `fanout` recipients; an
  `acknowledgedShare` of their receipts acknowledged; an `offlineShare` of recipients offline; and
  `inboundObligations` addressed to the measured participant, split between reply and
  acknowledgement.
- Fixture: the snapshot `computeAttention` reads.
- Validator: the exact expected attention items. Each pending receipt of an offline recipient
  gives `recipient_unavailable`, and each pending inbound obligation gives `reply_required` or
  `acknowledgement_required`, in ACC's priority order. Fully acknowledged history gives nothing.
- Observations: time per call; receipt and message visits, counted in one separate untimed call
  through proxies on the snapshot arrays.

### Inbox (#306)

- Scenario: `messages` addressed to the reader, a `backlog` addressed to other participants,
  and the operation, either `exact` (one message by id) or `page` (`limit` items).
- Fixture: a filesystem store built through the coordination service.
- Validator:
  - exact: the named message, and only its receipt moved to `retrieved`;
  - page: the oldest `limit` listable messages, in order, with a cursor exactly when more remain,
    and no receipt changed.
  In both cases every other receipt keeps its state and generation.
- Observations: primary reads by kind, bytes read, index page reads, and directory enumerations,
  from the existing store I/O probe; time per call. Each run starts from a fresh fixture copy, so
  the exact operation's transition is measured every time.

### Read-only transaction (#307)

- Scenario: `messages` held constant and `events` varied independently.
- Fixture: a filesystem store with that many messages and that many published events, the events
  made by ordinary writes.
- Validator: an exact receipt read returns the receipt's state and appends no event. A write
  probe in the same scenario must append exactly one event with the next sequence, which detects
  a skipped commit and an invalid order.
- Observations: event directory enumerations, primary reads and time per call.

## Negative mutations

Each probe ships mutations that wrap a correct implementation and break it: dropping an item,
returning a constant result, answering from a stale fixture, skipping the receipt transition,
moving an unrelated receipt, appending an event to a read, and skipping a write's commit. The
test suite runs every mutation through the validator and requires each one to fail. A correct
alternative implementation, such as attention with receipts grouped by message, must pass. That
shows the validator does not depend on the current algorithm.

## Comparable runs

`node scripts/measure/run.mjs --probe <name> --sizes … --baseline <ref> --candidate <ref|worktree>`
materializes each side, then alternates them:
- A side is a commit, exported with `git archive` and installed with `npm ci` into a temporary
  directory, or `worktree`, the current checkout with its dirty state recorded.
- Rounds alternate the order, baseline then candidate and then the reverse. Each side runs in a
  fresh process that builds its fixture, validates, warms up, and then records its samples.
- The run records:
  - each side's commit and a hash of its package sources;
  - the scenario hash and each side's fixture digest;
  - the Node and V8 versions, OS, CPU model, core count and memory;
  - the load average before and after each child;
  - the durability setting, real `fsync` by default;
  - every raw sample.
- A run whose sides validate differently, or whose fixture digests differ when the format is
  unchanged, is reported as invalid rather than compared.

## Reports

`report.md` beside `run.json` gives each side's median, interquartile range, minimum and maximum,
and its operation counts. It labels each figure:
- **Benchmark**: both sides valid, alternated over at least ten rounds, and at least one hundred
  samples per side.
- **Smoke**: valid, but short of that.
- **Diagnostic**: operation counts, which are deterministic and never benchmark results.
- **Insufficient evidence**: p95 below one hundred samples per side and p99 below one thousand.
  The report names the shortfall instead of printing the percentile.

## Where it lives

- `scripts/measure/`: probes, validators, mutations, runner and report. Not packed.
- `tests/measure/`: the suite's checks of determinism, validation, mutations, report rules, and
  a short runner pass with both sides `worktree`.
- Evidence of a comparison: `docs/release-evidence/` of the change that ran it.

## Not in scope

- The optimizations themselves: #305, #306 and #307.
- CLI cold start: #150.
- CI timing runs: runners are too noisy (the CPU lottery measured on 2026-10-06), as the
  maintainer decided.
