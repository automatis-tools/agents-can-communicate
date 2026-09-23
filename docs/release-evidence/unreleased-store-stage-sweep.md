# Unreleased the store sweeps its accepted staging files

A workspace store's `tmp/` directory grew by one file per published immutable record and nothing
in the product removed one. `publishAtomic` writes its bytes to a unique temporary, links that
inode to its destination, and then renames the temporary onto a deterministic name. The file
stayed because the store never unlinks: Node exposes `unlink` only by pathname, so validating a
parent and then unlinking still lets an adversary replace that parent in between. The
deterministic name bounded the residue to one file per destination rather than one per attempt.

Bounding is not reclaiming. The count only ever grew.

Two facts were read out of the tree before anything was changed. Nothing anywhere in the
repository reads a `*.published` path — the name is written at two places and read at none — so
the retry the comment bounded did not exist as a code path. And only the immutable branch leaks:
the `replace` branch publishes by `rename`, which consumes its temporary.

## What was measured

macOS arm64, ACC 0.6.2, 26 workspaces under `~/Library/Application Support/acc/workspaces`, on
2026-09-23.

- Before a manual sweep: 17,880 / 12,139 / 11,621 / 2,202 / 1,494 entries in the five busiest
  workspaces, about 48,000 in total.
- Every sampled entry matched `<64 hex>.published`, contained
  `{"retentionVersion":1,"transactionId":"transaction_…"}`, and had link count 2 — a hard link
  to a live record. Removing one frees a directory entry, not bytes.
- `find <store>/tmp -name '*.published' -delete` cleared them; `acc doctor` then reported
  `store healthy`, with no message, claim or binding lost.
- Within one day the same directories held 733 entries again, 356 of them in the busiest
  workspace.

## What changed

Accepted staging files are published into a new `stage/` directory. The sweep detaches that
directory with one `rename`, recreates it empty, moves any `*.published` an older version left
in `tmp/` into the detached copy, and discards it.

Removal therefore happens only inside a directory the sweep itself named with a random value and
already detached from the name any publisher resolves. That is the ground `releaseCanonical` in
`writer-mutex.mjs` already stands on, not the check-then-unlink window `atomic-json.mjs` refuses;
that comment stands unchanged.

A partial from a failed publication is never removed and never moved. The sweep only ever
renames names ending in `.published` out of `tmp/`, and a partial does not.

The sweep runs under the writer mutex, where recovery already runs, so no publisher is in flight
while the directory is detached. A marker in `locks/stage-sweep.json` records when the last pass
ran and one read decides whether an open is due; the interval is a day. Each pass is bounded to
512 entries, counting moves and removals against the one budget, and stops early on the
publication deadline. An interrupted pass leaves a single `stage.sweeping-<uuid>` that the next
pass adopts before detaching anything further, so they cannot accumulate.

`acc doctor` reports the counts. `acc doctor --repair` sweeps without the per-pass bound.

## Compatibility

Both directions were kept deliberately. A newer ACC on an older store creates `stage/` and
reclaims what is in `tmp/`. An older ACC on a migrated store does not know `stage/`, keeps
writing accepted stages into `tmp/`, and the sweep keeps reclaiming them. Both take the same
writer mutex, so a sweep and a publication never overlap. No store layout version is introduced
and nothing refuses to open a store.

## Checked against a real store

A copy of a live 0.6.2 workspace store — never the live one — was repaired with the new code.
The workspace held 484 accepted stages in `tmp/` and no `stage/` directory at all, which is what
every store written before this change looks like. A partial was planted by hand, since this
workspace had none.

```
before: tmp accepted=484 tmp partial=1 stage accepted=0
diagnose: healthy=true staged=484 partials=1 corrupt=0
repair:   healthy=true swept=484 staged=0 partials=1
after:  tmp accepted=0 tmp partial=1 stage accepted=0
records: events=276 state=159
leftover detached directories: 0
```

The planted partial was still present afterwards with its bytes unchanged, and all 276 events
and 159 state records remained readable.

This run is also what found the one defect in the change. `sweepAcceptedStages` validated the
stage directory before detaching it, outside the branch that tolerated its absence, so a store
with no `stage/` — which is every existing store — raised `ENOENT` from `acc doctor --repair`.
Both test fixtures had hidden it: the unit one creates the directory by hand, and the live-store
one gets it from opening the store. A unit test now reproduces a store that has never published
into `stage/`, and the directory is created before the detach so its absence is the ordinary
case rather than an error.

## Exact local artifact

- Source: clean commit `9e2d121f56ca10b9c80e9344a7ada16b1d869355`.
- Archive: `agents-can-communicate-0.6.3.tgz`, packed from that commit.
- Size: 449,834 bytes; 307 packed entries.
- SHA-256: `90f44abd3805a3becd43c344e505b3a673ef070a876954f6aff86e5e0be4b869`.
- Package version remains `0.6.3`; this is an unpublished development artifact.

The digest was produced by `scripts/verify-package.mjs` and reproduced by a separate `npm pack`.
An earlier candidate at `0968471`, before the fix described above, was measured the same way and
its digest was identical across three independent builds, so the measurement itself is stable
against repacking. The exact archive passed clean
installation verification: install into a directory with no workspace anywhere, `acc doctor`
reporting 6 adapters, a workspace with no Git, and an install followed by an uninstall that
restored topology, modes, links and bytes. The packed entry count rose from 306 to 307 with the
new `packages/storage-filesystem/src/stage-sweep.mjs`.

`npm test` on this tree: 2,471 passing, 0 failing, 1 skipped, of 2,472.

## Limits

The sweep is bounded per pass, so a store carrying tens of thousands of entries stays large
until enough passes have run; `acc doctor --repair` is the way to reclaim it at once. The
reported numbers above come from one machine's store. No capability claim, adapter
certification, or published interface changes, and no message, claim or binding is touched.
