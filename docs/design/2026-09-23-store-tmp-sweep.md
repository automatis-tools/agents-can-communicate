# Sweeping the store's accepted staging files

## Problem

A workspace store's `tmp/` directory grows by one file per published immutable record and is
never swept. `publishAtomic` in `packages/storage-filesystem/src/atomic-json.mjs` writes its
bytes to a unique `<stage>.<pid>.<uuid>.tmp`, links that inode to its destination, and then —
in the `finally` branch that runs once the bytes were accepted — renames it onto the
deterministic name `retainedStage()` computes, `tmp/<sha256 of the destination path>.published`.

The file stays because the store never unlinks. `atomic-json.mjs` states why: Node exposes
`unlink` only by pathname, directory handles cannot be passed to `unlinkat`, so validating a
parent and then unlinking still lets an adversary replace that parent in between. Retention is
the safe primitive; the deterministic stage name bounds the residue to one file per distinct
destination rather than one per attempt.

Bounding is not reclaiming. The count only ever grows, and nothing in `storage-filesystem`,
`core` or the `acc` command line removes a single entry.

## Evidence

macOS arm64, ACC 0.6.2, 26 workspaces under `~/Library/Application Support/acc/workspaces`.
Counts on 2026-09-23 before a manual sweep: 17,880 / 12,139 / 11,621 / 2,202 / 1,494 in the five
busiest, about 48,000 in total. Every sampled entry matched `<64 hex>.published`, contained
`{"retentionVersion":1,"transactionId":"transaction_…"}`, and had link count 2 — a hard link to
a live record, so removing it frees directory entries rather than bytes. One stray `*.tmp` was
present in one workspace.

`find <store>/tmp -name '*.published' -delete` cleared them and `acc doctor` reported
`store healthy` afterwards, with no message, claim or binding lost.

Within one day of that sweep the same directories held 733 entries again, 356 of them in the
busiest workspace.

Two further facts were read out of the tree before this design:

- **Nothing reads the retained stage.** `retainedStage` is referenced only where it is written
  (`atomic-json.mjs:82`, `atomic-json.mjs:125`). No reader anywhere in the repository opens a
  `*.published` path. The retry the comment bounds does not exist as a code path; what the
  deterministic name does is collapse garbage onto one name per destination.
- **Only the immutable path leaks.** The `replace` branch publishes by
  `rename(temporary, destination)`, which consumes its temporary. The `link` branch is the one
  that leaves a second name for an inode that is already safe at its destination.

## Principle

A directory the store writes to on every publication must have a rule that empties it. Where the
store cannot unlink safely, it removes by renaming a whole directory out of reach and then
discarding it — the primitive `releaseCanonical` already uses in `writer-mutex.mjs:57-74`, which
moves a complete lock aside rather than unlinking its contents.

What a file is must be decided by where it was created, not by how its name ends. A sweep whose
correctness rests on a suffix is a sweep every later change to the publication protocol has to
remember not to break.

## Design

### Layout

`DIRECTORIES` in `packages/storage-filesystem/src/store.mjs:32` gains `stage`. An accepted stage
is published to `stage/<sha256 of the relative destination path>.published`. `tmp/` keeps its
original role and nothing else: `publishAtomic` creates its unique `<…>.<pid>.<uuid>.tmp` there,
and a failure before acceptance leaves it there untouched.

This adds a directory to a list whose own comment argues against additions:

> No quarantine area. One was created in every workspace, named in the path typedef, and written
> to by nothing … An empty directory that reads as a feature is the same mistake as an attention
> kind with no rule behind it.

The objection is to a directory with no rule behind it. `stage/` has two: every immutable
publication fills it, and the sweep below empties it. It is the separation that makes the sweep
removal-by-directory instead of removal-by-suffix.

### The sweep

The sweep runs inside a transaction that already holds the writer mutex, so no concurrent
publisher exists for the duration.

1. Adopt orphans. Any `stage.sweeping-*` left in the store root by an interrupted earlier sweep
   is picked up and finished, the way `writer-mutex.mjs` reclaims its own `writer.candidate-*`.
2. `rename(stage, stage.sweeping-<uuid>)`. The whole directory loses the name anything could
   reach it through, atomically and in one call.
3. `ensureManagedDirectory(root, paths.stage)` recreates it empty.
4. Migrate the legacy residue: every `*.published` found in `tmp/` is `rename`d into
   `stage.sweeping-<uuid>`. Nothing is unlinked by name — the entries join the directory that is
   about to be discarded.
5. Discard `stage.sweeping-<uuid>` and its contents. A directory emptied within the pass budget
   is removed outright; one that is not is left for the next pass, which step 1 adopts.

A crash at any step leaves at most an orphaned `stage.sweeping-<uuid>`, which step 1 of the next
sweep finishes. It never leaves the store without a `stage/`, because a publication that finds
none calls `ensureManagedDirectory` for itself.

Step 4 exists because older ACC versions keep writing accepted stages into `tmp/` (see
**Compatibility**). It is a standing rule, not a one-off migration.

### When it runs

`locks/stage-sweep.json` records `sweptAt`. A transaction that already holds the writer mutex
reads it and sweeps when the recorded time is older than a day.

A count-based threshold was considered and rejected. An exact count costs either a full listing
of the directory the sweep exists to keep small, or an extra `fsync`ed write on every
transaction. A timestamp gives the same amortisation for one read.

### The hook budget

Step 4 on the store measured above is 17,880 renames in a single workspace. Performing that
inside a hook would reproduce the timeout fixed in 0.6.1, where unbounded directories made hooks
exceed their budget.

The automatic sweep is therefore bounded per pass, and the bound covers every entry the pass
touches — both the legacy entries step 4 moves and the entries step 5 discards. A store left
unopened for a long time can hold as many accepted stages in `stage/` as the measured store held
in `tmp/`, so discarding it in one recursive removal would cost exactly what moving it would.

The bound is 512 entries per pass, and the pass also honours `assertPublicationDeadline` from
`deadline.mjs`, so a slow filesystem stops it earlier than the count does. 512 renames or
unlinks inside one already-open directory is tens of milliseconds, against a transaction that
already pays for a lock directory, a write and two `fsync`s.

Steps 2 and 3 are outside the bound because they are one `rename` and one `mkdir` whatever the
directory holds — which is the property that makes detaching the directory the cheap part and
discarding it the part worth metering.

Draining a large accumulation therefore takes several passes, and no single pass holds a hook.

`acc doctor --repair` runs the same sweep without the per-pass bound, because an operator is
waiting on it and a hook is not.

### The operator path

No new top-level command. `doctor` already carries the store report
(`packages/cli/src/doctor-command.mjs:255`) and `--repair` already exists
(`packages/cli/src/args.mjs:42`), routed to `repairFilesystemStore`
(`packages/storage-filesystem/src/recovery.mjs:88`), which already takes the writer mutex and
already returns `{ healthy, repaired, blocked, corrupt }`.

- `acc doctor` reports how many accepted stages are held and how many partials are in `tmp/`.
- `acc doctor --repair` sweeps and reports what it reclaimed in the existing report.

### Partials

A partial from a failed publication is evidence that bytes may not have reached their
destination. The sweep never removes one and never moves one: partials live in `tmp/`, and the
sweep only ever renames `*.published` out of it. `doctor` names their count so a partial is
visible rather than silently kept.

Their growth is negligible — one file across 26 workspaces in the measured store — because a
partial is written only when a publication fails before acceptance.

## Compatibility

Both directions are supported, and the cost of supporting them is close to zero.

- **A newer ACC on an older store.** `stage/` does not exist; `ensureManagedDirectory` creates
  it. Accepted stages already in `tmp/` are reclaimed by step 4.
- **An older ACC on a migrated store.** It does not know `stage/` and never looks at it. It keeps
  writing accepted stages into `tmp/`, which step 4 keeps reclaiming.
- **Mixed versions against one store concurrently.** Both take the same writer mutex, so a sweep
  and a publication never overlap.

No store layout version is introduced. Nothing refuses to open a store because of this change.

## Security

The sweep removes only through two primitives the store already relies on:

- `rename` of a directory the sweep itself named, inside a root validated segment by segment by
  `assertManagedDirectory`.
- Removal inside a directory that no longer has a name any publisher can resolve, under a random
  `<uuid>` the sweep chose. This is the same removal `releaseCanonical` performs on its retired
  lock directory.

Entries are unlinked by pathname inside `stage.sweeping-<uuid>`, which the check-then-unlink
argument permits and `releaseCanonical` already relies on: the danger it describes is a *live*
name whose parent an adversary can substitute between the check and the call. This parent was
created by the sweep, named with a value no other process knows, and detached from the name any
publisher resolves before a single entry is touched.

No pathname-based `unlink` of a live name is introduced, so the window described in
`atomic-json.mjs:181-185` is not reopened. The comment stands as written.

One residual window is stated rather than closed. `withWriterMutex` treats an owner as stale
after `STALE_MS` (60s, `writer-mutex.mjs:13`), so a live but stalled publisher can have its lock
taken while it still holds an open temporary. That temporary is a partial in `tmp/`, which the
sweep does not touch, so the stalled publisher can still complete. Its accepted stage, if it
reaches one, is written into the new `stage/`.

## Testing

`packages/storage-filesystem/test/`:

- A live record is readable after a sweep that removed its accepted stage.
- A publication concurrent with a sweep, to the same destination, completes unharmed.
- A partial in `tmp/` survives a sweep at the same path and inode.
- An accepted stage left in `tmp/` by an older version is reclaimed.
- A sweep interrupted between the rename and the removal is finished by the next sweep, and the
  orphaned `stage.sweeping-*` does not accumulate.
- A bounded pass stops at its limit and leaves the remainder, counting both moved and discarded
  entries against the one budget, and repeated passes drain the remainder without leaving more
  than one `stage.sweeping-*` behind.
- A pass stops on the publication deadline before it reaches the count.
- `doctor` reports stage and partial counts; `--repair` reclaims without the per-pass bound.

## Out of scope

- The wider operator cleanup in #133 — offline participants, expired claims, history retention.
  This design deliberately fits inside the report `--repair` already returns so that #133 is not
  a prerequisite.
- Any change to what `retained/` means. It holds logical deletion markers
  (`retention.mjs:37,58`) and keeps its own retention rule.

## Risks

- **A directory added against a standing argument.** Mitigated by the rule that empties it, and
  by the conformance the tests above give it. If `stage/` is ever found empty by design rather
  than by sweeping, the argument in `store.mjs:26-31` applies to it and it should be removed.
- **Draining a large accumulation takes several passes.** A store carrying tens of thousands of
  entries stays large until enough sweeps have run. `acc doctor --repair` is the way to reclaim
  it at once, and `doctor` reports the count so the state is visible rather than inferred.
