# Indexed Transaction Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish #241 by removing unrelated message and receipt reads from message creation and receipt advancement without weakening coordination guarantees.

**Architecture:** Add explicit asynchronous record loading to both transaction implementations. Persist bounded, rebuildable indexes whose completeness is tied to the active journal generation under the existing writer mutex. Enable that writer discipline with store contract 7 and an explicit, fenced migration from contract 6.

**Tech Stack:** Node 24, ESM, node:test, built-in filesystem and crypto APIs; no new dependency.

**Spec:** [Approved design](../specs/2026-10-05-transaction-reads-design.md).

**Planning baseline:** `c2816d40`, including merged #258. Profile evidence comes from the unchanged production code in release 0.9.0. This plan does not assign #246 or #250, select a release, authorize a push, or authorize a merge.

## Global Constraints

- Node 24, ESM, built-ins only; no new runtime dependency.
- Core remains independent of filesystem details, adapters, Git and child_process.
- Existing durable record shapes, message IDs, receipt IDs and event vocabulary stay.
- Keep get, generationOf, list, put, remove and append signatures.
- Use one writer mutex for loading, lookup, staging and generation comparisons.
- Index files contain keys, record references and checksums, never message bodies.
- Hooks retain their five-second budget and fail-open behavior.
- No claim of a whole-suite or Windows speedup without measurement.
- Keep `JOURNAL_VERSION = 2`; set `STORE_VERSION = 7` and root `accStoreVersion = 7` together.
- Tree branches: at most 16 children. Every leaf/collision/group page: at most 32 entries and 65,536 encoded bytes.
- Only `messageByClientKey` and `receiptsByMessage` are supported indexes. Cache publication uses `durability: "none"`.
- Explicit prune order remains receipts, messages, intents, claims, sessions, participants.
- Work on `perf/transaction-reads`; keep focused modules/tests below 300 lines or explain cohesion in a header.
- Prove new guards with mutations. Show the local working result and obtain separate approval before creating a PR. Keep commit/pre-push hooks enabled.

## Review Focus

1. A heartbeat or non-message journalled change between sends must not trigger a full index rebuild (Task 3).
2. Generic transactions may create duplicate client keys or move a record between keys; preserve each backend's first match and update both keys (Tasks 2, 3, 6).
3. A metadata retirement may be interrupted after some files move; the applied prefix must be durable before an index proves an absence (Task 8).
4. Management-only dispatch may run newer code while the active runtime is older; migration must reach that code without admitting ordinary workspace commands or bypassing holds (Task 5).
5. A callback may overlap `load()` calls or throw after staging; cache pending loads, serialize reference-store writers, and publish neither records nor index changes on rollback (Task 1).

---

## File Responsibilities and Interfaces

Create these focused modules; existing entry points retain their responsibilities:

| File | Responsibility |
| --- | --- |
| `packages/protocol/src/transaction-indexes.mjs` | Closed index definitions and portable tuple validation; no filesystem imports |
| `packages/storage-filesystem/src/state-reads.mjs` | Validated envelopes used by eager and exact reads |
| `packages/storage-filesystem/src/transaction-view.mjs` | Declarations, pending loads, staged records and synchronous transaction methods |
| `packages/storage-filesystem/src/index-pages.mjs` | Canonical closed page encoding, limits and SHA-256 verification |
| `packages/storage-filesystem/src/index-tree.mjs` | Persistent radix routing, bounded ID groups and path copying |
| `packages/storage-filesystem/src/index-io.mjs` | Safe page/manifest paths and atomic, unflushed cache publications |
| `packages/storage-filesystem/src/index-cache.mjs` | Journal-generation validation, rebuild, automatic deltas, diagnostics |
| `packages/storage-filesystem/src/store-migration.mjs` | Explicit contract-6 recovery/build/version switch under writer lock |
| `packages/storage-filesystem/src/index-reclaim.mjs` | Reachability-safe page cleanup and indexed-prune durability |
| `packages/cli/src/store-migration-command.mjs` | Admission fencing and migration command outcome |
| `packages/core/src/message-retry.mjs` | Indexed retry selection and unchanged logical-content comparison |
| `tests/helpers/exact-transaction-contract.mjs` | Shared assertions registered once per backend by focused test entry points |
| `tests/helpers/transaction-read-probe.mjs` | Root-scoped actual reads/writes/bytes/flushes; restoration in finally |

Types used below: `Envelope = {kind, id, generation, record}`; `Loaded = Envelope | null`; `Root = string | null` (a 64-character lowercase SHA-256 or an empty tree); `Roots = {messageByClientKey: Root, receiptsByMessage: Root}`; `Tuple = string[]`; `Delta = {index, tuple, id, operation: "put" | "remove"}`. Records and IDs retain protocol validation.

The cache manifest is the closed object `{indexVersion: 1, workspaceId, journalGeneration, roots}`. Generation is the existing 16-digit idle journal generation. Files live at `indexes/v1/cache.json` and `indexes/v1/pages/<sha256>.json`.

## Task 1: Explicit Transaction Loads in Both Stores

**Files:** Create `packages/storage-filesystem/src/state-reads.mjs`, `packages/storage-filesystem/src/transaction-view.mjs`, `tests/helpers/exact-transaction-contract.mjs`, `packages/core/test/exact-transactions.test.mjs`, `packages/storage-filesystem/test/exact-transactions.test.mjs`. Modify `packages/storage-filesystem/src/store.mjs`, `tests/helpers/memory-store.mjs`, `packages/core/src/ports.mjs`.

**Interfaces:**
- `readStateEnvelope(paths, {root, workspaceId}, kind, id): Promise<Loaded>` and `loadStateEnvelopes(paths, {root}, wanted): Promise<Map<string, Envelope>>` replace the existing private state loading without dropping checks.
- `createTransactionView({kinds, exactKinds, loaded, loadEnvelope, ids, appendEvent, lookupIndex}): {tx, staged}`; `lookupIndex` is an optional future delegate, not an empty-answer stub.
- Both stores accept `transaction(callback, {kinds, exactKinds = [], deadlineAt})`. Nonempty exactKinds require explicit kinds and must be a subset. Existing calls retain eager loading.
- `tx.load(kind, id): Promise<object | null>` works on declared kinds; exact kinds are omitted from eager loading. `tx.get/generationOf/put/remove` require a completed explicit load for an exact ID; `tx.list` refuses an exact kind with `EXIT.DATA`.
- Add `assertExactTransaction(tx): void` in core ports; missing load/lookup support raises `AccError(EXIT.USAGE, ...)` when exact mode is selected. Ordinary custom ports remain constructible.

- [ ] **Step 1:** Add shared cases named `exact IDs must be loaded`, `pending and staged loads share one view`, `absent load and generation conflict`, and `exact rollback publishes nothing`. Register them through `runExactTransactionContract(name, makeStore)` in the two test entry points. Assert:

```js
await assert.rejects(store.transaction(tx => tx.get("message", "message_a"), exact),
  { code: EXIT.DATA });
await store.transaction(async tx => {
  assert.equal(await tx.load("message", "message_missing"), null);
  assert.equal(tx.generationOf("message", "message_missing"), null);
  assert.throws(() => tx.list("message"), { code: EXIT.DATA });
}, { kinds: ["message"], exactKinds: ["message"] });
```

Also prove the concurrent load delegate is called once, a staged put/load returns the new record, remove/load returns null, stale expectedGeneration raises EXIT.CONFLICT, undeclared access raises EXIT.DATA, and a queued second memory transaction sees the first committed write. Rollback leaves snapshot/events unchanged. An incompatible custom transaction handle produces the typed port error.
- [ ] **Step 2:** Run `node --test packages/core/test/exact-transactions.test.mjs packages/storage-filesystem/test/exact-transactions.test.mjs`; expect RED at absent support or forbidden access being accepted.
- [ ] **Step 3:** Implement the interfaces. Share envelope binding, deletion-generation markers, record validation and no-follow checks with eager reads. Refuse a foreign-workspace envelope in exact mode. Cache an in-flight load and retain the original envelope for comparisons/deltas. Use one reference writer queue for transactions, reclamation and ephemeral mutations, matching filesystem locking; ephemeral reads remain non-acquiring so a transaction can read them without nesting.
- [ ] **Step 4:** Run those tests plus `packages/storage-filesystem/test/store-contract.test.mjs`, `tests/process/transaction-scope.test.mjs` and the existing validated-directory tests; expect zero failures.
- [ ] **Step 5:** Commit `feat: add explicit transaction record loads` with only these files.

## Task 2: Bounded Persistent Index Trees

**Files:** Create `packages/protocol/src/transaction-indexes.mjs`, `packages/storage-filesystem/src/index-pages.mjs`, `packages/storage-filesystem/src/index-tree.mjs`, `packages/storage-filesystem/src/index-io.mjs`, `packages/storage-filesystem/test/index-tree.test.mjs`. Modify `packages/protocol/src/index.mjs`.

**Interfaces:**
- `assertIndexTuple(index, tuple): Tuple`: messageByClientKey requires three portable IDs; receiptsByMessage requires two. Canonical key bytes are UTF-8 `JSON.stringify(tuple)`.
- `indexKeysFor(kind, record): Array<{index, tuple}>`: message maps workspace/sender/clientMessageId; receipt maps workspace/messageId; other kinds return [].
- `encodeIndexPage(page): {hash: string, bytes: Buffer}`; `decodeIndexPage(hash, bytes): object` enforce canonical bytes, closed shapes, unique routes/tuples/IDs, limits and safe references. Export `IndexCacheUnavailable extends Error` with constructor `(reason, cause)` from index-pages.mjs; only cache IO/validation wraps this error, never primary loading or journal recovery.
- `createIndexTree({readPage, writePage, digestTuple}): {lookup(root, tuple): Promise<string[]>, apply(root, deltas): Promise<Root>}`. `digestTuple` defaults to SHA-256; the explicit seam permits deterministic digest-collision tests only.
- `createIndexIO({paths, root, publishOptions}): {readPage(hash), writePage(page), readManifest(), writeManifest(manifest)}`. Page writes publish immutable bytes before a replacing manifest; use existing containment primitives and durability none.

- [ ] **Step 1:** Add `tree splits without rewriting unaffected pages`, `duplicate keys retain ordered ID groups`, `full digest collisions remain separate`, and `invalid referenced pages cannot answer absent`. With 33 distinct keys, assert every encoded page has at most 32 entries and at most 65,536 bytes. With 129 IDs for one key, prove a bounded group rather than one large leaf; removing one ID preserves the others. Inject a constant 64-hex digest for 33 distinct tuples and prove each exact lookup survives collision paging. A missing referenced page, bad hash, noncanonical bytes, over-limit bytes, duplicate child, or invalid reference must raise IndexCacheUnavailable.

```js
assert.deepEqual(await tree.lookup(root, ["workspace_a", "participant_a", "client_a"]),
  ["message_a"]);
assert(publishedPages.every(({ bytes, entryCount }) => bytes.length <= 65_536 && entryCount <= 32));
await assert.rejects(tree.lookup(rootWithMissingChild, key), IndexCacheUnavailable);
```
- [ ] **Step 2:** Run `node --test packages/storage-filesystem/test/index-tree.test.mjs`; expect RED for missing implementation.
- [ ] **Step 3:** Implement hexadecimal radix routing, path copying and paged collision/ID groups. An absent child in a verified branch is a negative; a missing child file is a fault. Return filesystem IDs ordered with `localeCompare`, as `listJsonFiles` currently does. The reference backend will preserve Map insertion order instead. Preserve the full tuple beside its digest and deduplicate IDs.
- [ ] **Step 4:** Run the tree tests against both an in-memory page IO for the algorithm and the real safe filesystem IO for publication/containment. Assert an update writes only its affected paths and writes zero message-body bytes.
- [ ] **Step 5:** Commit `feat: add bounded rebuildable message index pages`.

## Task 3: Cache Validity and Automatic Writer Maintenance

**Files:** Create `packages/storage-filesystem/src/index-cache.mjs`, `packages/storage-filesystem/test/index-cache.test.mjs`. Modify `packages/storage-filesystem/src/store.mjs`, `packages/storage-filesystem/src/identity.mjs`, `packages/storage-filesystem/src/transaction-view.mjs`, `tests/helpers/memory-store.mjs`, `package.json`, `tests/process/store-concurrency.test.mjs`, `tests/store-contract-declared.test.mjs`, `packages/storage-filesystem/test/single-record-transaction.test.mjs` and current-contract expectations in existing store tests. Preserve intentionally legacy version-6 fixtures.

**Interfaces:**
- `createIndexCache({paths, root, workspaceId, publishOptions, loadPrimary}): {lookup(index, tuple, {active, staged, deadlineAt}), prepareDeltas(loaded, staged), commit({before, after, deltas, deadlineAt}), diagnostics()}`; all methods run under the caller's writer mutex. active/before/after are existing active-journal records; loaded/staged are the Task 1 maps; prepareDeltas returns Delta[]; loadPrimary returns validated live message/receipt envelopes. lookup returns Promise<string[]>; commit returns Promise<void> and handles only post-commit cache failures.
- `tx.lookup(index, tuple): Promise<string[]>` enforces declaration of the index's source kind and overlays staged old/new keys. The memory implementation derives the same answers from its committed/staged records.
- `store.indexDiagnostics(): Array<{code: "index_unavailable" | "index_rebuilt", reason: string}>` exposes only the last bounded diagnostic; the memory store returns []. Diagnostics contain no owner credentials or message bodies.

- [ ] **Step 1:** Add `generic indexed writes advance authority`, `cache survives unrelated journal changes`, `staged lookup and rollback`, and `cache faults preserve primary outcomes`. Assert a single message/receipt put without an event advances active generation; a lone session replacement still uses the existing shortcut. Change a generic message retry key and assert old lookup is empty and new lookup names it. Stage puts/removes and assert lookup overlays them, then throw and assert no persisted delta. Interleave an intent/session journalled change and a heartbeat between sends: subsequent indexed lookup reads no complete backlog. A reopened child process uses the persisted warm cache.

```js
assert.notEqual(afterIndexedPut.generation, beforeIndexedPut.generation);
assert.equal(afterHeartbeat.generation, beforeHeartbeat.generation);
assert.deepEqual(await lookupOldKey(), []);
assert.deepEqual(await lookupNewKey(), ["message_a"]);
assert.equal(unrelatedBacklogReadsAfterIntent, 0);
```
- [ ] **Step 2:** Run `node --test packages/storage-filesystem/test/index-cache.test.mjs tests/process/store-concurrency.test.mjs`; expect RED at absent lookup or stale generation handling.
- [ ] **Step 3:** Implement automatic deltas and bump both declarations to 7. Under the mutex, finish an open decided journal with existing readOpenJournals/rollForward before loading the transaction. Build both indexes lazily only when a lookup needs them; validate current idle generation and workspace before trusting roots. Journal every message/receipt put/remove, including one-record/no-event cases. Carry an already valid unchanged cache across non-index journal writes by restamping its manifest after commit; do not build a cache for an unrelated transaction. Never restamp roots from an invalid cache. Keep the existing shortcut for non-index single-record writes.
- [ ] **Step 4:** Inject failure after primary commit, between page writes, and before the manifest. Assert the committed message/event survives, the caller receives success, and the next lookup rebuilds rather than trusting stale roots. Add `after-index-pages` and `before-index-manifest` failAt phases confined to cache publication. Wrong generation/workspace, missing/corrupt pages and unsafe cache directories permit only verified primary fallback within budget; primary/journal/containment faults propagate. The read-only diagnostic reports a cache failure. Run cache, active-journal, crash-recovery, single-record-transaction and store-contract-declared gates; expect zero failures.
- [ ] **Step 5:** Commit `feat: maintain transaction indexes under store contract seven`.

## Task 4: Explicit Filesystem Store Migration

**Files:** Create `packages/storage-filesystem/src/store-migration.mjs`, `packages/storage-filesystem/test/store-migration.test.mjs`. Modify `packages/storage-filesystem/src/identity.mjs`, `packages/storage-filesystem/src/index.mjs`; reuse state reads and index cache.

**Interfaces:**
- `migrateFilesystemStore({root, workspaceId, clock, ids, allowMigration = false, platform, deadlineAt, failAt}): Promise<{fromVersion: 6 | 7, toVersion: 7, migrated: boolean}>` requires explicit allowMigration. Direct callers must quiesce other users first; the function cannot prove unmanaged processes stopped.
- Add `readMigrationIdentity(paths, workspaceId)` in identity.mjs, accepting only valid contract 6 or 7 for this explicit path. Ordinary requireStoreIdentity/readStoreIdentity remain contract-7-only and diagnose contract 6 with the explicit migration remedy.

- [ ] **Step 1:** Add `migration preserves records and initialized identity`, `migration recovers decided version-six journal first`, and `interrupted migration is retryable`. Seed validated v6 envelopes and an actual decided journal. Assert all primary record bytes remain unchanged; workspaceId and initialisedAt are preserved; final identity is 7; the complete cache matches recovered live records. Ordinary open on v6, opt-in omission, unknown versions, foreign workspace, corrupt identity, and corrupt primary state must refuse.

```js
assert.equal(identityAfter.storeVersion, 7);
assert.equal(identityAfter.initialisedAt, identityBefore.initialisedAt);
assert.equal(identityAfter.workspaceId, identityBefore.workspaceId);
assert.deepEqual(primaryBytesAfter, recoveredPrimaryBytesBeforeSwitch);
```
- [ ] **Step 2:** Run `node --test packages/storage-filesystem/test/store-migration.test.mjs`; expect RED at absent migration.
- [ ] **Step 3:** Implement lock acquisition, ownership validation, existing v6 journal recovery, full validated index build, then atomic durable protocol.json replacement last. Add `before-store-version-switch` and `after-store-version-switch` failure phases. A deadline before the switch leaves v6; a decided recovery finishes with existing durability semantics. Keep journal/record schemas unchanged. An already migrated identity is idempotent and verifies/rebuilds its cache.
- [ ] **Step 4:** Repeat with failures before/after the identity switch and after prepared cache pages. Assert a retry completes, identity never derives from cache existence, and no reverse migration occurs. Run migration plus existing recovery/identity contract tests; expect zero failures.
- [ ] **Step 5:** Commit `feat: add explicit version six store migration`.

## Task 5: Fenced Doctor Migration and Installed Entry Points

**Files:** Create `packages/cli/src/store-migration-command.mjs`, `packages/cli/test/doctor-store-migration.test.mjs`, `tests/acceptance/store-migration-packed.test.mjs`. Modify `packages/cli/src/args.mjs`, `packages/cli/src/help.mjs`, `packages/cli/src/main.mjs`, `packages/cli/src/doctor-command.mjs`, `packages/cli/test/managed-runtime-management-entry.test.mjs`, `docs/CLI.md`, `docs/UPGRADING.md`, `docs/ARCHITECTURE.md`.

**Interfaces:**
- `runStoreMigration({options, context, runtime}): Promise<{data, text}>` uses a located diagnostic context and the library migration from Task 4. Result data is `{workspaceId, fromVersion, toVersion, migrated}`.
- Accept `doctor --migrate-store`; reject combination with --repair using EXIT.USAGE. Help and current docs explain quiescing old/unmanaged callers; ordinary --repair never migrates.
- In main, distinguish `managementMigration` from ordinary managementDoctor. Explicit migration resolves locateContext before any openService; management-only ordinary workspace commands remain refused.

- [ ] **Step 1:** Add `migration reaches newer management code`, `different or unknown holders refuse migration`, and `admission stays fenced through workspace migration`. Through real command parsing/dispatch, assert the new flag is accepted, conflicts with --repair, and uses the newer verified management implementation when active code is older. Live v6 leases/native pins, unknown contracts/PIDs and unreadable holds must refuse without modifying protocol.json. Only the current command's own lease may be ignored; never ignore a native binding of the same PID. A competing admission cannot pass until migration releases the fence.

```js
assert.equal(parseArgs(["doctor", "--migrate-store"]).options.migrateStore, true);
assert.equal(blockedMigration.exitCode, EXIT.CONFLICT);
assert.deepEqual(identityAfterRefusal, identityBefore);
assert.equal(admissionPassedBeforeMigrationReleased, false);
```
- [ ] **Step 2:** Run `node --test packages/cli/test/doctor-store-migration.test.mjs packages/cli/test/managed-runtime-management-entry.test.mjs`; expect RED for unsupported flag/dispatch.
- [ ] **Step 3:** Implement the handler using withManagerLock, readControl and listActivationBlockers with incomingStoreVersion 7 and ignorePid process.pid. Live/unknown holders yield AccError(EXIT.CONFLICT); unsafe/corrupt management state yields EXIT.DATA. Require ready management state; wrap library migration inside admission then writer locking, with no nested manager acquisition. For an unmanaged install, use the data home's ordinary manager location as the same admission fence; do not claim this fences direct library callers. Do not contact npm, refresh integrations or restart clients. Wire bounded indexDiagnostics into doctor/command diagnostics without changing recorded-send success.
- [ ] **Step 4:** Run the actual packed current acc binary on a v6 fixture in an isolated home. Use the existing createUpdateRegistry fixture's private version `0.9.99` to exercise selection above an active `0.9.0`; only copied fixture metadata changes, never repository release versions. Assert migration works without first opening a v7 service, takes no runtime admission shortcut for unrelated commands, and current CLI can send/retry afterward. Invoke the actual packed hook on an unmigrated v6 store: exit is successful/fail-open, stderr explains migration, and identity stays 6. Run args/help, existing broken-store doctor and runtime activation-contract gates alongside the new tests; expect zero failures.
- [ ] **Step 5:** Commit `feat: expose fenced doctor store migration` with its user-facing documentation.

## Task 6: Indexed Message Creation, Replies and Handoffs

**Files:** Create `packages/core/src/message-retry.mjs`, `packages/core/test/indexed-conversations.test.mjs`. Modify `packages/core/src/conversations.mjs`, `packages/core/src/decision-changes.mjs`, `packages/core/src/inbox.mjs`; reuse current idempotency, decision-lifecycle, inbox-and-reply and finish-retries tests.

**Interfaces:**
- `findMessageRetry(tx, session, input): Promise<object | undefined>` moves the existing logicalContent/normalizedContent comparison out of the 300-line conversations module. It consumes tx.lookup and tx.load; all send/finish call sites use the same function.
- `recordMessageInTransaction(options): Promise<{message, recipientParticipantIds, created}>` and `prepareDecisionChange(tx, input, session): Promise<object>` retain their arguments and become async.
- Send and finish keep participant/session listings; finish also keeps claims. Their message/receipt kinds become exact. Reply keeps its current participant/session listings and selects exact message/receipt kinds.

- [ ] **Step 1:** Add `creation does not list messages or receipts`, `generic duplicate keys preserve first match`, `staged decision recipients include offline peers`, and `generated IDs still conflict`. Wrap real transaction handles to throw only on core calls to list(message/receipt), not on backend maintenance. Assert send, reply and finish work; unchanged retries return the original; changed normalized content raises EXIT.CONFLICT; the existing ambiguous tuple test still passes. Seed duplicate keys through the generic store and compare indexed first match to each backend's original eager ordering. A room decision's actually stored receipts, including an offline peer, must be inherited. Generated message/receipt ID collisions must refuse and roll back both records/events.

```js
assert.equal(retried.messageId, first.messageId);
assert.equal(indexedFirst.messageId, eagerFirst.messageId);
assert(inheritedRecipients.includes("participant_offline"));
await assert.rejects(sendWithCollidingId(), { code: EXIT.CONFLICT });
```
- [ ] **Step 2:** Run `node --test packages/core/test/indexed-conversations.test.mjs`; expect RED on the existing message/receipt list calls.
- [ ] **Step 3:** Implement the async changes and await them in send, finish and reply. Normalize client-name recipients and decision inheritance before retry comparison. Verify each loaded retry candidate matches its workspace/sender/key; keep logical ownership checks. Explicitly load referenced parents/decision targets and receipt IDs selected by receiptsByMessage; filter deleted/orphan references. Load newly generated message/receipt IDs as absent before put. Keep receiptId encoding unchanged. Do not pass an exact handle into broad inbox/history/decision projections.
- [ ] **Step 4:** Run the new tests against real filesystem and reference stores plus existing idempotent-conversations, decision-lifecycle, inbox-and-reply, finish-retries and addressing-by-client tests; expect zero failures. A session replaced while a writer waits must still yield EXIT.CONFLICT under the mutex.
- [ ] **Step 5:** Commit `perf: use indexes for message creation and decision inheritance`.

## Task 7: Exact Receipt Read, Offer and Acknowledgement

**Files:** Modify `packages/core/src/receipts.mjs`, `packages/core/src/inbox.mjs`, receipt visibility/offer/idempotency and acknowledgement tests. Create `tests/process/transaction-read-cost.test.mjs` and the read probe helper; reserve later performance assertions in that same file.

**Interfaces:** Existing service method signatures stay. readReceipt selects exact message/receipt kinds; offer success/failure and acknowledgement select exact session/message/receipt kinds. Broad listInbox/readInbox stay eager in this scope. Shared requireOwnedReceipt/advanceOwned paths are loaded before synchronous access; requireOpen preserves ephemeral-session fallback under the writer mutex.

- [ ] **Step 1:** Add `receipt operations read only their named state records`. Seed the real 60-message/two-participant fixture, reset root-scoped counters after preparation, then assert readReceipt reads exactly 2 state records, successful offer exactly 3, and acknowledgement exactly 4 including its pre-transaction owner lookup. Assert offer failure reads no unrelated record. Verify queued -> offered -> retrieved -> acknowledged remains monotonic, orphan receipts refuse, repeat eligibility is rechecked, reply-required acknowledgement still refuses, and stale semantic session generations after mutex waiting fail.

```js
assert.equal(receiptRead.stateReads, 2);
assert.equal(successfulOffer.stateReads, 3);
assert.equal(acknowledgement.stateReads, 4);
assert.deepEqual(acknowledgement.result.state, "acknowledged");
```
- [ ] **Step 2:** Run `node --test tests/process/transaction-read-cost.test.mjs`; expect RED at the existing 120/122/123 primary-read observations, not an elapsed-time threshold.
- [ ] **Step 3:** Implement explicit loads before requireReceipt/requireTarget/requireOwnedReceipt/requireOpen access. Cache repeated same-ID loads through Task 1. Await asynchronous transaction callbacks; retain generationOf comparisons and event/no-op rules. Reuse existing receipt tests rather than duplicating their scenario matrix.
- [ ] **Step 4:** Run the cost test, existing receipt-visibility, receipt-offer-idempotency, acknowledgement-contract and inbox-and-reply gates; expect zero failures and exact count targets. Counters exclude index/journal/marker reads from primary-record counts but report those separately.
- [ ] **Step 5:** Commit `perf: read exact records for receipt operations`.

## Task 8: Prune Durability and Bounded Cache Reclamation

**Files:** Create `packages/storage-filesystem/src/index-reclaim.mjs`, `packages/storage-filesystem/test/index-reclaim.test.mjs`. Modify `packages/storage-filesystem/src/store.mjs`, `packages/storage-filesystem/src/reclaim.mjs`, `packages/core/test/prune.test.mjs`, `packages/storage-filesystem/test/reclaim.test.mjs`; reuse journal and doomed-directory primitives.

**Interfaces:**
- `reclaimIndexPages(paths, {root, roots, limit, deadlineAt}): Promise<{reclaimed, remaining}>` removes only pages proven unreachable under the writer mutex. The work budget covers page traversal as well as removal; a budget-insufficient or unverified reachability pass deletes nothing it cannot prove unused. Large reachability scans may defer to explicit prune rather than consume every hook's budget.
- `withIndexedPrune(paths, publishOptions, operation): Promise<unknown>` durably changes authority before indexed physical retirement, makes the applied primary prefix durable, and leaves idle authority before unlocking. The operation receives a collector for affected primary/retention parent directories.

- [ ] **Step 1:** Add `prune cannot leave a falsely current negative cache`, `reclaimed retry key may be reused`, and `bounded sweep keeps every reachable page`. Warm the cache, prune a bounded prefix and reopen: surviving keys/recipients remain, reclaimed keys may be reused, and no ghost recipient is created. Restore an old retained primary filename in a simulated post-crash fixture and assert stale cache is invalidated and live state wins. Trim all retained events and assert surviving retry lookup is unchanged. Set reachability/cleanup budgets too small and assert all referenced page bytes survive.

```js
assert.deepEqual(await lookupSurvivingKey(), [survivingMessageId]);
assert.deepEqual(await lookupReclaimedKey(), []);
assert.deepEqual(referencedPagesAfterLimitedSweep, referencedPagesBefore);
assert.notEqual(authorityAfterPrune.generation, authorityBeforePrune.generation);
```
- [ ] **Step 2:** Run `node --test packages/storage-filesystem/test/index-reclaim.test.mjs`; expect RED for missing cache invalidation/durability/cleanup support.
- [ ] **Step 3:** Implement the indexed prune fence with an existing empty-publications journal entry: activate before physical mutation, finish the applied prefix, then idle. On POSIX sync validated affected primary/marker parent directories before idle/unlock; on Windows the final existing journal flush commits earlier NTFS metadata renames. No extra durable cache marker or per-message flush. If the deadline expires after moves, finish durability of that prefix; preserve existing budget order. Discard the invalidated cache on explicit indexed prune and lazily rebuild later. Hook maintenance uses bounded reachability and existing safe condemnation; no unconditional whole-tree traversal at every open.
- [ ] **Step 4:** Inject interruption before retirement, between prefix moves and before idle; recovery must never use matching roots to prove a false absence. The flush recorder must show the primary rename before its durability fence. Run existing core prune, filesystem reclaim/retention/recovery and the new tests; expect zero failures.
- [ ] **Step 5:** Commit `fix: keep message indexes safe through pruning and cache cleanup`.

## Task 9: Mutation Proofs, Actual Artifacts and Performance Evidence

**Files:** Complete `tests/process/transaction-read-cost.test.mjs` and its probe helper. Keep measurement drivers, loader mutants, logs and before/after artifacts in an owned temporary evidence directory; do not commit duplicated logs or test modes. Update the shown local result and issue report only within existing authorization.

**Interfaces:** `measureTransactionIO(root, operation): Promise<{result, stateReads, pageReads, pageWrites, readBytes, writtenBytes, flushes, elapsedMs}>` restores every intercepted method in finally and observes actual filesystem handles. It never supplies fake primary records or cache answers.

- [ ] **Step 1:** Add `steady sends do not scale primary reads with backlog` to the cost gate. In the same two-participant fixture, collect successful state reads for the last warmed send at 20/40/60 messages and assert equality. Reopen before one final lookup and assert no full primary scan. Collect cache pages/bytes/flushes separately; first build and forced recovery are explicit separate phases. Interleave ordinary journal changes as in Review Focus 1. These tests contain no wall-clock pass/fail threshold.

```js
assert.equal(lastSendAt20.stateReads, lastSendAt40.stateReads);
assert.equal(lastSendAt40.stateReads, lastSendAt60.stateReads);
assert.equal(unrelatedBacklogReadsAfterReopen, 0);
assert.equal(flushesOfIndexFiles.length, 0);
```
- [ ] **Step 2:** Run the cost gate against unchanged contract-6 production code or a loader forcing eager loading; expect RED at the named count guard. Run the completed candidate; expect GREEN and receipt 2/3/4 counts. Record the actual send constant, tree IO growth and recovery cost; reject evidence that only moves quadratic work to cache writes.
- [ ] **Step 3:** Prove each protection with one exact RED mutation: force eager exact-kind loading; trust a stale epoch; omit the new-key delta on a generic update; bypass generation comparison; ignore a deletion marker; bypass exact-read containment; skip the final identity switch; bypass migration holder refusal. Use isolated loader mutations, restore unchanged code, then repeat the relevant focused GREEN once. Archive the applied patch and each exit/assertion; an unrelated setup failure does not count.
- [ ] **Step 4:** Verify two actual installed artifacts in isolated homes. Fetch the published `agents-can-communicate@0.9.0` once outside the repository, verify the archive against its recorded SHA-256 `df4700148f5710536155af47b05a0f211d5c8a5d09dee5c945e2b5a5303881c6` and registry integrity, and install with lifecycle scripts disabled. If the published bytes differ, reconcile their provenance before claiming exact-artifact proof. The real old binary creates a v6 store; the actual newly packed candidate (private fixture version 0.9.99 as in Task 5) migrates it; the old binary must refuse a new open afterward; the new binary preserves message retries and can advance receipts. Do not require an npm network request in every ordinary test run. The live managed old-writer test must refuse before migration and allow only after confirmed process death; direct unmanaged users remain an explicit operator responsibility.
- [ ] **Step 5:** Commit the final focused performance guard/evidence references as `test: prove indexed transaction read costs` before validating and showing that exact head.
- [ ] **Step 6:** Run Node 24 `npm ci`, `npm run check`, the focused gates and `node scripts/verify-package.mjs`; expect all required checks to pass. Coordinate one quiet local full-suite window and run `npm test`. If push permission is already explicit at that point, its mandatory pre-push suite may serve as that final full run. Otherwise validate locally first and let the hook run normally on a later authorized push. Never bypass a hook or manually repeat a full suite merely for another timing number.
- [ ] **Step 7:** Measure before/after on Windows with the same artifact/fixture and report primary reads, index IO/bytes, flushes and elapsed time separately. Preserve the current CI temp-disk selection and platform skips. Use a local installed Windows environment if available; otherwise show local proof first and request the necessary probe/PR authorization before GitHub writes. Do not silently make a PR to obtain a Windows runner. Report any missing platform proof as outstanding.
- [ ] **Step 8:** Obtain whole-branch review with the chosen execution method, fix material findings, and run only checks invalidated by those fixes. Show the concrete local result with counts, mutation failures, installed migration, recovery limitations and retained evidence. Wait for this PR's separate local-result approval; only then push/create a PR if authorized. Do not merge or publish a release.
- [ ] **Step 9:** Archive owned obsolete scratch files and release claims/intent when pausing or handing back the result.

## Self-Review and Handoff

Spec coverage: exact loading/staging/ports in Task 1; closed keys/pages/groups/order in Task 2; epochs, generic writes, reopen/recovery/fallback in Task 3; version transition in Tasks 4–5; retries, ownership, inheritance and ID collisions in Task 6; monotonic receipts in Task 7; physical prune/history/cache reclamation in Task 8; mutations, real artifacts and local/Windows evidence in Task 9. Every Review Focus input has an owning test above.

Planning does not require a full suite. No production file is changed by this document. Before implementation, the user reviews this plan and chooses execution. Native execution is recommended: these nine tasks share the transaction view, journal epoch and migration interfaces, and keeping implementation in this session avoids repeated context setup. It includes one fresh whole-branch review at the end. Subagent-driven execution remains an alternative if the user chooses per-task independent reviews.
