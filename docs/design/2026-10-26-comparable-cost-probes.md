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

Every call gets its own input, prepared outside the timed section: a copy of the attention
snapshot, or a store instance opened as a hook process opens one. The store probes validate
through a second instance opened after the call, so an answer kept in the measured instance's
memory is checked against what the store holds. A probe states how many calls a scenario
allows. The runner refuses a scenario too small for its warm-up calls, samples and observed call
before anything runs.

### Attention (#305)

- Scenario: `ownRequests` sent by the measured participant, each to `fanout` recipients; an
  `acknowledgedShare` of their receipts acknowledged; an `offlineShare` of recipients offline;
  `inboundObligations` addressed to the measured participant, split between reply and
  acknowledgement; and `witnesses`, 4 by default.
- Witnesses are items that every scenario must return, whatever its shares: requests to a
  participant with no session, and pending inbound obligations. Their ids carry the seed, so an
  answer computed for another fixture never matches. A scenario that expects nothing cannot tell
  useful work from a constant answer, and the validator refuses one.
- Fixture: the snapshot `computeAttention` reads.
- Validator: the exact expected attention items. Each pending receipt of an offline recipient
  gives `recipient_unavailable`, and each pending inbound obligation gives `reply_required` or
  `acknowledgement_required`, in ACC's priority order. Fully acknowledged history gives nothing
  beyond the witnesses.
- Observations: time per call; receipt and message visits, counted in one separate untimed call
  through proxies on the snapshot arrays.

### Inbox (#306)

- Scenario: `messages` addressed to the reader, a `backlog` addressed to another participant,
  the operation, either `exact` (one message by id) or `page` (`limit` items, 20 by default as in
  the product), and `mix`. With `mix`, obligations are spread over none, acknowledge and reply,
  each with its protocol kind (note, decision, question), and the reader's receipts are moved in
  turn to queued, offered, retrieved and acknowledged through the product's own operations.
- Fixture: a filesystem store built through the coordination service.
- Validator, through a fresh store instance after each call:
  - exact: the named message with its subject, body, kind and obligation; its receipt in the
    state the read must leave (`retrieved`, or unchanged when already retrieved or acknowledged);
    the generation changed exactly when the state changed; and exactly one `message.retrieved`
    event for it when the state changed, none otherwise;
  - page: the newest listable messages first, between one and `limit` of them, since a page may
    end early at the product's byte budget; each item's receipt state; a cursor equal to the last
    item exactly when more remain; a follow-up page from that cursor that continues the list; and
    no receipt, generation or event changed.
  In both cases every other receipt keeps its state and generation.
- Each exact call reads a message not read before, so the scenario allows `messages` calls.
- Observations: primary reads by kind, bytes read, index page reads, and directory enumerations,
  from the existing store I/O probe; time per call.

### Read-only transaction (#307)

- Scenario: `messages` held constant, `events` varied independently, the operation (`read` or
  `write`), and `pendingJournal`.
- Fixture: a filesystem store with that many messages and that many published events, the events
  made by ordinary writes.
- `pendingJournal` stops one decided offer after its journal, as a crash would. Every read of that
  message must return `offered`. A store may finish the decided write while it serves a read; its
  `message.offer_succeeded` event is then allowed once and is not counted as the read's commit.
- Validator: an exact receipt read returns the receipt's state and commits no event. A write must
  commit exactly one `message.offer_succeeded` event with the next sequence for its own message,
  which detects a skipped commit, a second commit and an invalid order. No unrelated receipt
  changes in either case.
- Each write offers a message not offered before, so a write scenario allows `messages` calls.
- Observations: event directory enumerations, primary reads and time per call.

## Negative mutations

Each probe ships mutations that wrap a correct implementation and break it in one way:
- attention: drop one item, answer a constant empty list, skip unavailable recipients, duplicate
  the first item, answer from a stale fixture, reverse the order;
- inbox exact: read the wrong message, skip the receipt transition, move the receipt without its
  event, return a summary for the body, move an unrelated receipt, return an extra item;
- inbox page: drop the last item, return an empty page, advance receipts, reverse the order,
  return a garbage cursor, ignore receipt states;
- transaction: commit on a read, return the wrong receipt, advance a receipt on a read, answer
  from stale state, skip a write's commit, commit twice, write to the wrong target.

The test suite runs every mutation through the validator and requires each one to fail. A correct
alternative implementation, such as attention with receipts grouped by message, must pass. That
shows the validator does not depend on the current algorithm.

## Comparable runs

`node scripts/measure/run.mjs --probe <name> --set <key=value> --vary <key=a,b> --baseline <ref>
--candidate <ref|worktree>` materializes each side, then alternates them:
- A side is a commit, exported with `git archive` and installed with `npm ci` into a temporary
  directory that is reused only after a completed install, or `worktree`, the current checkout
  with its dirty state recorded.
- Rounds alternate the order, baseline then candidate and then the reverse. Each side runs in a
  fresh process that builds its fixture, warms up, records its samples, validates every call, and
  observes one more call.
- A child that fails, or overruns `--timeout-ms` (15 minutes by default) and is killed, is
  recorded with its error. The run continues and is still written.
- The run records:
  - each side's commit, its dirty state and a hash of what it runs: package sources, the package
    manifests, the lockfile and `bin/`;
  - the harness commit and its dirty state;
  - the scenario hash and each side's fixture digest;
  - the Node and V8 versions, OS, CPU model, core count and memory;
  - the load average before and after each child;
  - the durability setting, real `fsync` by default, and the `NODE_OPTIONS` the children got;
  - every raw sample.
- A run whose sides validate differently, whose child failed, or whose fixture digests differ when
  the format is unchanged, is reported as invalid rather than compared.

## Reports

`report.md` beside `run.json` names each side's ref, commit and sources hash, the harness, the
durability and host, each side's fixture digests and any child errors or validation failures. It
gives each side's median, interquartile range, minimum and maximum, and its operation counts. It
labels each figure:
- **Benchmark**: both sides valid, alternated over at least ten rounds, and at least one hundred
  samples per side.
- **Smoke**: valid, but short of that.
- **Diagnostic**: operation counts. They are nearly deterministic: bytes read vary slightly with
  the width of the process ids a fixture records. They are never benchmark results.
- **Insufficient evidence**: p95 below one hundred samples per side and p99 below one thousand.
  The report names the shortfall instead of printing the percentile.

## Limits

- The validators see results and the store, not how the result was made. A side that memoizes an
  answer by content across calls in one process could pass. Fresh inputs and fresh store
  instances per call make such a memo visible only when the content changes between calls.
- The store I/O probe counts reads through the store's file operations. A direct promise read it
  does not wrap is missed (#347), so its primary-read counts are a lower bound.

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
