# Unreleased: resumable automatic index cleanup

PR [#263](https://github.com/automatis-tools/agents-can-communicate/pull/263),
HIGH [review comment](https://github.com/automatis-tools/agents-can-communicate/pull/263#discussion_r4190875689).

| Candidate artifact | Value |
|---|---|
| Built from | `39079ea6fadeb944dbf913f8635175139faa0cf1` |
| Tarball | `agents-can-communicate-0.9.1.tgz`, 573,530 bytes, 350 files |
| sha256 | `711d0ee034437c5ceb399bac8f1e9effb9e22eb08323f340c7692fdacf10574d` |
| Runtime / platform | Node 24.4.0, macOS arm64 |
| Capture | 2026-10-06 UTC |

This is an unpublished development archive built from a clean committed tree
after merging main's 0.9.1 release. Its metadata inherits that version; this
candidate uses contract 7 and does not describe the published contract-6 0.9.1.
The evidence commit changes only unpacked documentation and CHANGELOG.md.
Earlier and published captures retain their original provenance.

## Automatic cleanup on the installed artifact

The exact archive was installed into a separate consumer. Its real binary
created a non-Git workspace; installed store modules seeded 600 actual messages,
built the index and changed one client key. There were 813 reachable pages and
819 total pages. Five ordinary installed `acc status` calls completed automatic
maintenance: page counts were 819, 819, 819, 817, 813. The completed sweep marker
appeared only on the fifth open. All 813 reachable page files and all 600 primary
record files retained their original bytes. The installed `doctor --repair`
then reported a healthy store and zero retired entries to remove.

Each status call took 0.76–1.06 seconds in this one fixture; these are observations,
not a before/after command or whole-suite speedup. Ordinary writer-locked passes
share the existing 512-operation budget across marking, sweeping and progress
IO. Descriptor probes on fresh-process automatic opens observed at most 510
page reads per pass and zero index flushes.

## Regression and mutation evidence

The original implementation failed the real large-graph completion regression.
Restored code passed 28 focused cache, prune, read-cost and progress checks; the
15 cleanup checks passed again after mutations were removed. Mutations that
restart marking, reset the sweep cursor, omit admission of a new current root,
trust a damaged checkpoint, flush progress, or leave a lost old pending page
in the checkpoint each failed the corresponding behavior guard. Exhausting the
shared budget also failed before the fix that leaves maintenance due.

The warmed send/receipt count guards still pass. They do not infer that earlier
Windows timings measured this new archive. Windows verification of this repair
has not been observed at this capture.

## Local full gate and merge follow-up

The full gate at `8d072a86` ran 3157 tests in 445.84 seconds: 3149 passed, seven
skipped and one failed. All new cleanup regressions passed. The sole failure was
the packed migration test expecting the pre-merge literal `0.9.0` after main's
version had become `0.9.1`. Its expectation now compares the retained active
version with the installed fixture manifest; the actual packed migration file
passed both tests in 14.84 seconds after correction. This test-only correction
does not change the archive above. The complete corrected gate remains for the
mandatory pre-push; this capture does not claim it has passed.

## Limits

Progress stores a conservative superset: pages from an intervening retired root
can wait for the next completed cycle before reclamation. Its visited hashes are
read and rewritten once per pass, with a 64 MiB checkpoint read safety limit;
directory enumeration and visited-set memory remain proportional to cache size.
Missing, damaged or unsafe progress restarts verification. Primary authority
faults remain visible. Deadline-expired passes leave cleanup for another open.

No new native-client capability, release or physical power-cut proof is claimed.
