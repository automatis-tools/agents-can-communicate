# Indexed transaction reads for #241

Status: proposed design for user review. No production implementation exists.
Source baseline: release 0.9.0, `27ee77ac`. This document covers the full message
lookup as requested, together with exact receipt reads.

## Outcome and evidence

Sending or advancing one message must not read the unrelated message backlog.
Keep participant/client-key retries, decision inheritance, recipient resolution,
generation checks, atomic publication, recovery and containment intact.

Fresh Node 24.4.0 observations on 2026-10-05 reproduce the original audit:

| Sequential messages | Successful state-file reads |
| --- | ---: |
| 20 | 500 |
| 40 | 1800 |
| 60 | 3900 |

At a backlog of 60, readReceipt reads 120 records; offer success reads 122;
acknowledgement reads 123. Reopening the store still makes one receipt read 120
records. Evidence and a reproduction driver are retained in
`/private/tmp/acc-docs-release.bKm4TY/241-FINDINGS.md` and `record-reads.json`.

There are two costs: eager loading of declared kinds in store.mjs and the
message history scan for a participant/client-key retry in conversations.mjs.
Decision changes also select receipts for their target messages. Optimizing
only known receipt IDs would leave the send path quadratic.

## Choices and recommendation

| Approach | Cost and correctness |
| --- | --- |
| Exact receipt reads only | Smallest change; leaves message creation scanning history. Does not finish #241. |
| Durable authoritative indexes | Journal index publications with state; adds flushed files to every message and more migration/recovery machinery. |
| Rebuildable paged indexes, validated against journal generation | Recommended: removes scans in steady operation, avoids index flushes and can discard incomplete cache state. Requires a versioned writer discipline. |

A single JSON index would rewrite the whole mapping for every send. A cache
held only in process would rebuild in each CLI process. Directory timestamps
or a cached negative answer do not prove that an older writer added nothing.
None is sufficient for the chosen goal.

## Contracts and scope

- Node 24, ESM, built-ins only; no new runtime dependency.
- Core remains independent of filesystem details, adapters, Git and child_process.
- Existing durable record shapes, message IDs, receipt IDs and event vocabulary stay.
- Keep get, generationOf, list, put, remove and append signatures.
- Add async loading and lookup to the transaction handle; keep existing callers
  eager unless they opt into exact kinds.
- Use one writer mutex for loading, lookup, staging and generation comparisons.
- Index files contain keys, record references and checksums, never message bodies.
- Hooks retain their five-second budget and fail-open behavior.
- No claim of a whole-suite or Windows speedup without measurement.

## Transaction interface

`transaction(callback, { kinds, exactKinds, deadlineAt })` accepts exactKinds
only as a subset of declared kinds. Other kinds retain current full loading.

`await tx.load(kind, id)` loads a declared exact record and its generation once,
including an absent result. It returns the record or null and seeds the view
used by existing synchronous methods. Repeated loads share the same result;
staged changes override it.

`await tx.lookup(index, tuple)` returns ordered record IDs from one of the closed
indexes below. The caller then loads those IDs. Lookup overlays staged puts and
removals, so it describes the same transaction as get and generationOf.

For an exact kind, get/generationOf/put/remove on an ID not loaded explicitly
raises EXIT.DATA. list on an exact kind also raises EXIT.DATA. This prevents a
partial view from silently answering that no conflict exists. Missing declared
records remain null; stale expected generations still raise EXIT.CONFLICT.

Load envelopes through the existing safe file access, filename binding,
generation-deletion marker and record validation checks. Do not use synchronous
filesystem access. Cache a pending load too, to avoid duplicate reads in one tx.

The reference store enforces the same declarations and staging rules. Its
indexes derive from its committed state; it cannot ignore the new options.
Validate transaction-handle support when selecting exact mode; an incompatible
custom port reports an AccError rather than an incidental TypeError.

## Indexes and page layout

Two closed index names are sufficient for this scope:

- messageByClientKey: `[workspaceId, fromParticipantId, clientMessageId]` to
  message IDs. Preserve each backend's existing first-match order if a generic
  store caller previously created several matching records. Do not introduce a
  new uniqueness constraint at the storage layer.
- receiptsByMessage: `[workspaceId, messageId]` to receipt storage IDs. This
  preserves the actual recipients of room decisions, including offline peers.

Use canonical tuple encoding before hashing; concatenation is ambiguous.
Reference IDs are validated, and the loaded record must match the tuple. A
receipt lookup filters missing/deleted sources and verifies association. Core
still performs its current logical-content comparison and ownership checks.

Persist immutable content-addressed pages under `indexes/v1/pages/<sha256>.json`.
A radix tree routes SHA-256 keys by hexadecimal digits. Branches have at most
16 children; leaves have at most 32 entries and 64 KiB of encoded bytes. Split
before exceeding either limit. Keys with the same digest retain distinct full
tuples; at full digest depth, use a paged collision list rather than exceeding
the leaf bounds. A key's record-ID group is another paged set, so room fanout or duplicate
legacy keys cannot make one page unbounded.

Path copying updates only affected pages. Verify canonical page bytes against
their filename hash and validate the closed page shape before using them.
Never interpret a referenced missing page as an absent key. An absent branch in
a verified page can prove a negative lookup; a missing/corrupt referenced page
invalidates the cache and requires a rebuild.

`indexes/v1/cache.json` holds indexVersion, workspaceId, journalGeneration and
the two root hashes. It is replaced atomically only after all referenced pages
have been published. Cache publications use durability none: authoritative
state and the existing journal remain durable. Loss of cache bytes costs a
rebuild, not a coordination fact.

## Validity, writes and crash recovery

Read the active journal under the writer mutex before trusting a cache. A cache
is valid only for the same workspace and the exact current idle generation.
Finish or refuse an open decided journal before serving indexed transaction
reads; use the existing roll-forward semantics without reacquiring the lock.

Every version-7 put/remove of message or receipt must use the journal, even a
single-record write without an event. Thus every indexed-state change advances
the durable journal generation. Keep the one-record shortcut for other kinds.

At transaction start, use a verified cache or rebuild from live validated
message and receipt envelopes. Do not build it on every store open or on a
transaction that needs neither index. The rebuild respects the operation's
deadline. A normal large migration performs the initial build outside hooks.

Derive index changes automatically from old and staged envelopes. All writers,
including generic transaction callers, update both old and new keys as needed.
Core callers cannot be the only place index maintenance happens.

Commit authoritative state and events through the existing journal first.
While still holding the writer mutex, publish changed cache pages and finally
the manifest stamped with the resulting idle generation. Index publication
failure cannot turn an already committed send into a failed send; leave the
cache invalid and expose an index-unavailable diagnostic.

A crash before state commit leaves the previous cache applicable. A crash after
state commit but before cache publication leaves a generation mismatch. A
machine crash that retains a manifest but loses a referenced page is detected
by page traversal. In the latter two cases, rebuild from primary state before
trusting an indexed answer. No additional index WAL or completion marker exists.

Physical pruning may leave stale positive references. Resolve them against
current live envelopes; they never establish a recipient or a retry by
themselves. Before physical message/receipt reclamation, advance the durable
journal generation under the mutex and invalidate the cache. Make affected
primary-directory renames durable before releasing that mutex or checkpointing
a new cache. Otherwise a power loss could restore a primary filename while a
matching cache incorrectly proved its absence. These extra durability writes
belong to explicit pruning, not each message. Preserve the current budgeted
prefix ordering and complete the durability of any applied prefix even if its
operation deadline expires. A reclaimed primary record permits retry-key reuse
as today. History trimming must not affect live-index completeness.

Immutable cache pages also need reclamation. Extend existing bounded maintenance
under the writer mutex to remove pages proven unreachable from the current
verified roots. If reachability cannot be established within budget, defer that
cleanup; never guess a page is unused. Explicit prune may instead discard the
whole invalidated cache and let the next indexed operation rebuild it. Cache
page loss after a machine crash is safe because a missing referenced page
invalidates its manifest. Do not add an unbounded sweep to every hook.

Cache recovery can replace malformed cache bytes but must never catch and hide
a primary-state, journal or containment fault. Unsafe cache paths are not read
or written through; use verified primary loading within budget and report the
cache problem. Primary corruption retains the current error behavior.
Checksums detect cache inconsistency; they do not authenticate another local
user process. Completeness relies on the version-7 writer discipline within the
repository's existing local-user storage boundary.

## Store contract and transition

Propose STORE_VERSION 7 and accStoreVersion 7, while retaining the current
durable record schema and journal format. Version 6 allows indexed records to
change through its single-record shortcut without advancing journal generation;
such a writer could leave a falsely complete cache. Therefore version 6 and 7
must not write one migrated store concurrently.

The existing runtime activation rule blocks a differing or unknown contract
and ignores only the updater's own lease. It does not fence unmanaged callers
that import the store directly. Do not claim it proves those callers stopped.

Add an explicit `acc doctor --migrate-store` mode in the new runtime for the
selected workspace, separate from ordinary `--repair`. Resolve the workspace
through locateContext without first opening a version-7 service on version-6
state. The mode uses existing runtime admission checks, holds admission before
the workspace writer mutex, and refuses differing/unknown live holders. It does
not install a release or contact npm. Direct library use
must explicitly opt into a migration after the operator quiesces other callers.
A hook never changes a version-6 identity automatically or waits on migration;
it returns the ordinary fail-open result with the migration diagnostic.

Under the locks: validate workspace ownership; recover any version-6 decided
journal; read and validate live state; build a complete cache; atomically replace
protocol.json with version 7 last. Do not rewrite primary messages or receipts.
Cache state left before the version switch is ignored by version 6. After a
crash, version 7 verifies or rebuilds its cache; the durable identity must never
be inferred from cache availability. Preserve initialisedAt and workspaceId.

Resuming version 6 against a migrated store is refused by its existing identity
check. No reverse migration or automatic client restart is part of #241.
Unknown store versions, foreign workspaces and corrupt identities remain refused.

## Core changes

Make recordMessageInTransaction and prepareDecisionChange async. Their send,
finish and reply callers await them within the existing writer transaction.
Resolve participants and sessions through the current bounded listings.
Use messageByClientKey for retries; load the parent and decision targets by ID;
use receiptsByMessage for inherited recipients. Keep canonical recipient/content
normalization before retry comparison and retain generation checks.

Preload a new message or receipt ID as absent before staging it. A generated-ID
collision is still a conflict. Do not change receiptId encoding.

Use exact session/message/receipt loads in readReceipt, offer success/failure and
acknowledgement. Keep orphan-receipt checks and monotonic offered/retrieved/ack
rules. Broad inbox/history/decision views retain their complete listings for
this scope; their APIs must not accidentally receive an exact-kind handle.

## Proof and performance criteria

Reuse existing service, crash, containment, publication and installed-artifact
gates. Add focused contract coverage rather than copying all scenarios:

- Both stores: exact declaration enforcement, absent records, staged reads,
  generation conflicts, lookup overlays and rollback.
- Separate processes: warm persisted lookup after reopen; competing writers;
  stale semantic session generations after waiting for the mutex.
- Real primary mutations: retry tuple separation, changed logical content,
  generated-ID collisions, decision inheritance, room/offline recipients.
- Cache faults: missing referenced page, corrupt bytes, wrong root generation,
  failure between page/manifest writes, and failure after primary commit.
- Migration: live/unknown holders refuse; version-6 crash recovery precedes the
  switch; old code refuses after switch; interrupted migration is retryable.
- Prune and trim: no ghost recipients, no lost surviving retry, permitted reuse
  after reclamation, crash-safe primary-directory retirement, bounded cache
  reclamation, and no live-index dependency on retained event history.
- Mutation proofs: force eager kind loading, skip epoch validation, omit one
  index delta, omit generation/deletion/containment checks. Each relevant gate
  must fail on the exact omitted protection.

Measure state reads, cache page reads/writes, bytes, flushes and elapsed time
separately. Use the same 20/40/60 fixture and report initial-build/recovery cost
apart from warm steady operation. With its two participants, normal sends should
have a bounded per-send state-read count; receipt read/offer/ack targets are
2/3/4 successful state-record reads. These are hypotheses until implemented.

Reject a claimed improvement that merely moves quadratic work to cache writes,
adds per-message flushed index files, or drops checks. Measure Windows as well
as local Node 24, and show the working local result before any implementation PR.

## Review and next stage

The principal tradeoff is a versioned migration in exchange for a provable
negative lookup without extra durable index writes. This proposal requires user
review, particularly that transition, before an implementation plan is written.
The plan must also prove lock ordering and the old-writer refusal on the actual
installed artifact. Nothing in this document authorizes a release or merge.
