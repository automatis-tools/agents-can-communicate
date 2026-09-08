# Codex LocalDaemon implementation and verification

Implementation and verification are complete on `feat/codex-local-daemon`.
This is a verified local candidate, not a published release. Nothing has been
pushed, merged, published, or posted to GitHub.

## Final outcome

Ordinary Codex launch from B now remains in B while ACC delivers to that exact
verified LocalDaemon thread, even when the daemon started earlier in A. The final
installed npm artifact passed all P01–P20 scenarios on **both 0.152.1 and 0.153.4,
darwin-arm64**: **20 cases / 189 assertions per version**, zero failed cases,
owned processes stopped and temporary state removed.

| Required gate | Observed result |
|---|---|
| `npm ci` | PASS |
| `npm run check` | 357 files, PASS |
| `npm test` | 1,567 total; 1,565 PASS, 0 FAIL, 2 existing conditional skips |
| Actual packed install / doctor / install / uninstall / evidence checks | PASS |
| Remove selected full product evidence from independently repacked artifact | Rejected by exact missing-evidence gate |
| Corrected candidate → final artifact | All 131 runtime files byte-identical; no added/missing files |
| Current-binding retirement/replacement mutation | 26 intended failures, 4 safe controls; restored 30/30 |
| Independent corrected-runtime cold/150-second idle observations | Three per client version, six distinct receiver threads |
| Whole-branch review and scoped correction review | One Important issue fixed; no remaining findings |
| Refreshed primary evidence / independent audit review | PASS, no findings |
| `git diff --check` | PASS |

Repository gates ran on Node v26.5.1 / npm 11.17.0,
darwin-arm64.
The two skips are pre-existing environment branches: Gemini is installed on this
machine, and darwin-arm64 has a passing capture. No new test was skipped.

Final artifact: `agents-can-communicate-0.3.1.tgz`, 279,820 bytes,
213 entries, built from `85f347d201df126b1f60cff96e1e6a5a14b0c8d8`.
SHA-256: `ebe370dc8452fd14f1441138aacfd4a13b0f85c3b94ba710cec3ec35837e3ccb`.
The artifact is retained at
`/private/tmp/acc-codex-implementation/public-final-reviewed/agents-can-communicate-0.3.1.tgz`.

The shipped selected product receipts name the prior tested corrected runtime
`945f6178357b6424a219b59cc3b9c4688b322c9da07cadf2bc7205bf20770940`.
The external final receipts name the final tarball itself; together with runtime
byte equivalence, this avoids a self-referential package hash. Earlier positive,
negative and partial capture bytes remain unchanged.

Durable records:
[final gates](evidence/codex-local-daemon/final-gates.json),
[0.152.1 final matrix](evidence/codex-local-daemon/codex-0.152.1-final-product.json),
[0.153.4 final matrix](evidence/codex-local-daemon/codex-0.153.4-final-product.json),
[cold/idle repetitions](evidence/codex-local-daemon/cold-start-repetitions.json),
[artifact equivalence](evidence/codex-local-daemon/runtime-equivalence.json),
[missing-evidence mutation](evidence/codex-local-daemon/missing-product-evidence-mutation.json),
[current-binding mutation](evidence/codex-local-daemon/current-binding-mutation.json),
[initial final review](evidence/codex-local-daemon/initial-final-review.md),
[correction review](evidence/codex-local-daemon/current-binding-review.md),
[refreshed evidence review](evidence/codex-local-daemon/refreshed-evidence-review.md),
[complete attempt register](evidence/codex-local-daemon/attempt-register.json), and
[hashed evidence index](evidence/codex-local-daemon/index.json).
The remaining sections preserve the diagnosis, boundaries and chronological
investigation; old hashes/results describe the implementation at that point.
The register retains 82 individual attempts, including rejected and partial runs.
The historical `transport-01534-3` cleanup failure remains a failure in its original
receipt. A [final read-only reconciliation](evidence/codex-local-daemon/final-cleanup-reconciliation.json)
found no Codex process remaining under the owned E2E/preflight roots; it does not
rewrite that historical result.


## Diagnosis

The workspace mismatch in [upstream issue 42457](https://github.com/openai/codex/issues/42457)
was reproducible with the former ACC wrapper. For a new explicit `--remote` thread
without `--cd`, invoked from B while the daemon runs in A, hooks, thread metadata,
and an actual `pwd` all report A. That is the actual session directory. Ordinary
Codex LocalDaemon launch from B preserves B even when the daemon runs in A.

The fix reuses the reachable ordinary session and verifies its exact thread, cwd,
client process/version and receiver-owned socket. It removes ACC's launch rewriting.
It does not infer workspace from the terminal invocation directory or choose another
loaded thread when identity checks fail.

## Implementation

- Requested delivery consent is recorded separately from current reachability. Hooks
  and the installed skill pin the ACC data home; an older daemon need not inherit
  ACC environment variables. Send rereads current consent before native delivery.
- Receiver registrations use private endpoint files and opaque random references.
  Identity, protocol, exact stable version, canonical cwd and loaded/live state are
  checked before binding, refreshing and offering. First-turn metadata reads use
  `includeTurns:false` only after complete valid listings omit an already-loaded ID.
- A 120-second delivery lease can be refreshed on demand for the same live endpoint.
  Retirement/generation races refuse refresh; presence still expires after 24 hours.
- Retirement uses one shared deadline, including acquisition of the storage writer
  lock and the check before publication. An indeterminate clear refuses a new
  handshake. A queued clear cannot begin after its deadline; this does not promise
  cancellation of a filesystem write that has already begun.
- Upgrade retires unchanged owned Codex wrappers. Modified wrappers remain visible
  with their original cleanup authority; unrelated shared shell artifacts and
  pre-existing daemons remain in place.

## Verification method

The harness installs a real npm tarball into a clean prefix with spaces, starts an
owned daemon from A before opt-in, and launches exact vendor binaries through an
ordinary interactive shell in plain B/C directories. Product sends use the installed
ACC CLI, real generated hooks and binding/router; the model reads/replies with the
installed skill. Direct queue calls are confined to separately labelled transport
and controlled failure diagnostics.

The PTY consumes terminal bytes only in memory. Preserved evidence contains closed
outcomes, synthetic identifiers, timestamps, package hashes and assertion/cleanup
counts. No transcript, prompt, answer, authentication content or raw protocol traffic
is collected. Disposable vendor state and the authentication symlink are removed.

## Initial recorded results

The reviewed transport matrix passed on Codex 0.152.1 and 0.153.4, macOS arm64:
four cases and 15 assertions per version. It checks exact B binding, same-thread
rejection with A cwd, idle queue acceptance, pending busy delivery and rejected
submission with a durable queued receipt. The complete P01-P20 installed product matrix passed on both versions: 20 cases
and 189 assertions per version, with verified cleanup and valid final evidence.
Both initially used the reviewed private artifact `a6a38da5...`; later corrected
runtime and final public-artifact results are recorded above.

Real installed migration used legacy commit
`fb148d41c0c890d86e3219e79ed961e78005eb9f`, package 0.2.0, SHA-256
`96f0ddb5d884148046de137b3d19d71c2fe3e6d5da018d734e8044fa31121e3a`.
Sixteen behavioral assertions passed. Two independently packed regressions failed
their exact gates: skipping wrapper retirement and deleting modified wrapper bytes.
The shared Claude shim is an unrelated artifact fixture created by the installed
legacy installer; this does not certify a Claude client capability.

Three independently packed mutations were caught on 0.152.1:

| Mutation | Failing gate |
|---|---|
| Restore the old `--remote unix://` wrapper | P01: actual cwd, hook cwd and thread cwd must all be B |
| Substitute another loaded same-workspace thread ID at queue submission | P02: only the exact B1 thread may execute the automatic turn |
| Skip canonical cwd validation for the exact loaded thread | T01: the same B1 thread must reject registration with A cwd |

Controlled real transport failures on both 0.152.1 and 0.153.4 accepted queue/add
and then lost the acknowledgement locally. Retrying the same message after its queue entry was consumed
executed the synthetic command twice. The model had already retrieved the durable
message. Queue deduplication protects a pending entry; it does not guarantee
exactly-once execution after consumption.

## Failed attempts and corrections

- Initial real first-turn hooks could not bind because persisted `thread/list`
  omitted a newly loaded thread. Exact metadata-only fallback fixed this without
  reading turns. A review reproduction then found malformed list entries could
  reach fallback; these now refuse before any metadata read.
- Early PTY readiness checks assumed an obsolete footer. The harness now recognizes
  the current prompt using closed UI flags. A generic usage-limit banner was not
  treated as proof of an actual service limit.
- Isolated `/cd` diagnostics initially targeted an untrusted directory. Codex
  explicitly refused it. A real client launch in C establishes vendor trust before
  this test; no trust record is manufactured.
- Vendor daemon-stop commands sometimes returned nonzero after the owned process
  had exited. Cleanup now verifies owned PID exit and uses bounded, ownership-checked
  termination only when needed.
- Full attempts on both versions each completed 13 cases before P14 timed out.
  A focused ordinary `/cd` diagnostic subsequently changed to C and observed the
  new thread ID, but resume from C opened the vendor working-directory selection
  dialog. The harness must choose the existing session directory without persisting
  a preference or rewriting launch arguments. Earlier P13/P14 runs also used B2
  while their facts named B1; those attempts are not certification evidence.
- The generic terminal detector matched `unexpected argument` in model tool stderr
  during the observer-free path. This is not proof that the vendor rejected its
  launch. Startup classification and owned-process cleanup were corrected and
  passed scoped review, including allocation failure before canonicalization.
- Package audit review found that dispatching solely on a capture's own capability
  label let an empty or relabelled file bypass product-evidence validation. The
  passing Codex manifest claim now requires full evidence regardless of that label.
  The correction passed its exact mutation and scoped review.
- Partial diagnostic commands deliberately exit nonzero and write
  `incomplete-evidence.json`; their passing subsets cannot certify the full matrix.

## Delivery boundaries

Native delivery requires recorded opt-in and a reachable, verified current session.
Embedded sessions, unsupported clients/platforms, missing daemons and failed identity
checks retain durable inbox access. Turning delivery off or uninstalling blocks new
offers; it cannot withdraw a submission already accepted by the vendor queue.
Replies use `acc reply`; native `delivery.replyRoute` remains false. This work adds no
new lifecycle, guard, or exact-version next-turn certification.

Closing the TUI does not necessarily end its daemon-owned thread. On both tested
versions, normal terminal exit left the thread loaded; an opted-in ACC question
then executed the requested synthetic command and received an actual model reply
without a frontend. Resuming that loaded thread produced a fresh exact
`UserPromptSubmit` but no new `SessionStart`. The exact-version upstream documents
describe eventual unload after 30 minutes without subscribers or thread activity,
and `SessionEnd` before archive, delete, or graceful server shutdown. The 30-minute
interval is source evidence, not an observed wait in these tests.
See the [0.152.1 app-server lifecycle contract](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/app-server/README.md#example-unsubscribe-from-a-loaded-thread)
and [0.153.4 contract](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md#example-unsubscribe-from-a-loaded-thread).

Final gate counts, complete matrix receipts, artifact equivalence and review verdicts
are recorded at the beginning of this report.


## Attempt register before final harness review

All entries below are incomplete diagnostic receipts, not full product certificates.
The receipts are retained under `/private/tmp/acc-codex-implementation/`. Early cleanup
fields report what that harness checked; the final harness adds explicit PTY driver
and owned-child reaping verification before its final runs can certify cleanup.

| Attempt | Versions | Completed product cases | Interpretation |
|---|---|---|---|
| `base-1`, binding/initial diagnostics | 0.152.1 | none | Exposed first-turn metadata lookup failure |
| `base-2` | 0.152.1 | P01 | First-turn fix observed |
| `base-3` | 0.152.1 | P01, P02 | Exact receiver isolation observed |
| `cold-1`, `cold-2` | both | P01, P03, P06, P04 | Separate cold/long-idle observations; earliest 0.152.1 run launched the pinned executable directly |
| `core-matrix-1` | 0.152.1 | P01, P03, P06, P04, P05, P07, P08, P15, P16, P17, P09, P19 | Completed selected subset |
| `modes-1` | both | P01, P12, P13 | P14 remained incomplete; actor labelling later corrected |
| `full-1` | both | P01, P02, P03, P06, P04, P05, P07, P08, P15, P16, P17, P12, P13 | Failed at P14; 13 completed cases, not a complete matrix |
| `modes-2` | both | P01 | P14 incomplete; known directory-trust refusal observed in one diagnostic |
| `cd-diagnostic-1` | 0.153.4 | none as a complete case | `/cd` transition observed; resume directory dialog remained unhandled |
| `recovery-1` | 0.152.1 | P01, P18 | Stopped at false startup-error classification during P20 |
| `recovery-1` | 0.153.4 | P01, P18, P20, P10, P11 | Completed selected recovery subset |

Private runtime artifact hashes used in these attempts:

- Before first-turn correction: `776222b2724436eb8b19877be1cfc1d95963ad53804f4b26fd040dab939cff2d`.
- First-turn correction: `0de0a5e723b1939441e9e2ea2bf258e4553c139c8c18d1ce2fb3eb91b18e1a08`.
- Reviewed metadata validation (`80b184c`): `131ded0a90a8a03131e72fe5ebac87be62a5e19617675da06685429deb90d456`.

The controlled ambiguous-ack receipts are `ambiguous-01521-2/ambiguous-ack.json`
and `ambiguous-01534-1/ambiguous-ack.json`, both against the reviewed metadata
artifact. The initial 0.152.1 attempt failed because the diagnostic incorrectly
expected the receipt to remain queued after the model had already retrieved it;
the corrected diagnostic records the actual retrieved state before retry.


The reviewed harness's cwd-validation mutation ran on 2026-09-08 from
06:21:11.638Z to 06:22:07.061Z against implementation artifact
`bdd78a4c1978f05322e156737660a43150971beecdcdc45985afaa66faa349dc`.
The mutant artifact was
`d42568a895fa6bd559ac8f340298d09035797e2823852eb48dfe8e6062a1891b`.
It failed the exact same-thread/wrong-cwd gate; verified cleanup passed.
Receipt: `mutant-cwd-reviewed-1/mutation.json`.


Fresh transport receipts on that same `bdd78a4c...` artifact are
`transport-01521-reviewed-2/evidence.json` and
`transport-01534-reviewed-3/evidence.json`: four passed cases, 15 assertions and
verified cleanup per version. The preceding 0.153.4 attempt
`transport-01534-reviewed-2/incomplete-evidence.json` passed T01 and accepted the
idle submission but timed out waiting for its marker; cleanup passed. Its precise
cause was not captured. The subsequent run retained only closed UI statuses and
completed all four cases; the original failed receipt remains unchanged.


The fresh `full-2` product attempts on both versions completed P01/P02/P03/P06/P04/
P05/P07, then failed in P08. Node26's `assert.deepEqual` masked a failed comparison
when passed an explicit undefined optional message. Commit `652ac68` fixes the
harness diagnostic to name the case and assertion without emitting raw compared
values. The later retirement investigation below explains a reproduced binding failure;
these earlier runs did not preserve enough facts to identify their precise cause. Both failed
attempts retained verified cleanup. An initial selected-policy diagnostic omitted
its required P01 setup and failed with PTY KeyError; the corrected command includes
P01. None of these partial attempts is product certification.

## Retirement and lifecycle follow-up

A later 0.153.4 P08 failure preserved closed diagnostic facts: one live receiver
with the expected generation and actionable policy, but a retired binding and no
`SessionEnd`. Its fresh `UserPromptSubmit` failed before entering adapter binding.
The old retirement helper independently bounded its steps; a core clear waiting
for the filesystem writer could outlive that wait and retire the prior endpoint
after the hook had refused to rebind. Real-filesystem contention tests reproduced
both the premature refusal and late retirement, then passed the shared-deadline
fix. Three exact mutations caught quarter-budget restoration, missing core deadline
forwarding, and missing pre-publication deadline checking. A follow-up hung-service
test also caught the optional no-cleanup branch's direct unbounded await.

The runtime fixes are `61316f1` and `1f2ad4e`, with 77 initial focused passes and
18 follow-up focused passes; scoped reviews are clean. A natural instrumented
retry passed with clear durations of 43–125 ms. It did not observe a naturally
over-budget clear, so that timing is not claimed as captured production evidence.

The resume-directory dialog used terminal cursor positioning between words.
Whitespace normalization of only its three literal markers corrected recognition;
the client expects one selection byte, with no following Enter. Commit `37f06f9`
passed the real PTY regression, its exact literal-whitespace mutation, and scoped
review. This correction alone did not make P14 pass.

Both `product-01521-detach-archive-2` and `product-01534-detach-archive-2` observed
detached execution/reply and fresh resume identity as described above. Their UI
`/archive` attempts did not exit within the deadline. Both remain incomplete,
with verified cleanup. Real `thread/archive` API diagnostics subsequently tested actual
server teardown and generated hooks separately. Later successful UI archive
captures are recorded below; these earlier attempts remain incomplete. The new private package is
`b8eb1bee2296746953b3929ef37b45434588264736f756ac9811f5b80107b300`,
packed after those runtime fixes; it was not release-certifiable while the
complete product matrix remained incomplete.

## Client trust lost during policy reinstall

Both `product-01521-retirement-full-1` and
`product-01534-retirement-full-1` passed 13 cases through P13, including the
previously failing P08/P15 routes, then P14 refused `/cd C` with the vendor's
`destination-untrusted` diagnostic. Both verified cleanup. Separate fresh
`retirement-cold-1` runs passed P01/P03/P06/P04 on each version: 38 assertions,
including 150 seconds without a hook heartbeat, plus verified cleanup.

The controlled 0.153.4 `trust-lifecycle-1` run confirmed an installer defect:
after the real P02 C launch, the isolated configuration recorded C as trusted;
applying ACC's `stripBlock` to those bytes in memory removed that trust entry.
After P08's actual installed policy reinstalls, the trust entry was absent from
the real file, and remained absent through P13. P14 then reproduced the refusal.
Only closed trust-state metadata was retained; configuration contents were not
persisted in the diagnostic. Cleanup passed.

Codex had inserted its project-trust table before ACC's trailing managed-block
marker. Replacing that entire comment-delimited region deleted client-owned
state. Re-trusting C in P14 would hide this defect. The Codex installer must
preserve foreign settings placed inside its marker region on reinstall and
uninstall. The reviewed correction and its exact mutations are recorded below.

The reviewed lifecycle harness (`c6dfd4e`) now requires the actual archive
confirmation, exact `SessionEnd`, unloaded thread, retired binding and a queued
actionable question before starting a fresh receiver. Its 16 focused tests and
three exact mutations passed, with clean scoped review. At that point the full matrix remained uncertified pending configuration
preservation and actual UI verification; later results are recorded below.


## Config preservation and actual archive verification

The isolated `product-01521-archive-ui-1` and
`product-01534-archive-ui-1` runs passed P01/P14: 26 assertions per version,
including the real archive confirmation, `SessionEnd`, retired binding, unloaded
thread, queued actionable question and a newly bound ordinary receiver. Both
verified cleanup. They deliberately selected a subset and exited incomplete;
this supersedes the earlier unobserved UI-archive result without treating either
as a full matrix pass.

Commit `8fdc695` adds a Codex-local TOML ownership scanner. It preserves foreign
tables and their raw bytes even inside ACC markers, and refuses ambiguous owned
content before modifying plugin files. Both initial install/uninstall regressions
failed against the old implementation. The corrected focused set passed 65 tests;
restoring blind managed-region removal failed five of the 15 new tests. A scoped
review found an additional inline-table preflight conflict, so this correction
was not considered review-complete until the follow-up below.

The new public-disabled tarball, SHA-256
`8b8fc8012c8f28f41755922ad08131ff1140c0352bab30d54b8d6b2b0395d634`,
passed installed-package verification. The corresponding private runtime candidate
is `1a903ae79414355e460b975b3f90fbdf4f46633366f147080f833e0f1ec1cc49`.
The subsequent real trust-preservation and full-product outcomes are recorded
below; no outcome is inferred from the focused tests or package check.


The follow-up `f03b136` refuses closed foreign registration-parent assignments
before writes, while ordinary table headers and unrelated sibling declarations
remain usable. Five exact omission-mutant failures prove that refusal gate; two
diagnostic mutations prove config-path/structural-reason checks. The 75-test
covering set and scoped re-review passed, with no remaining findings. The scanner
still preserves values as raw bytes and uses no generic inline-value parser.

The actual 0.153.4 `product-01534-trust-preservation-1` run passed P01/P02/P08
and a real installed uninstall on `1a903ae7...`: client-written C trust remained
trusted after both policy reinstalls and removal, and ACC markers were absent
after uninstall. Cleanup passed. This is deliberately partial evidence, not a
full certificate.

The reviewed corrected runtime candidate at that point was
`a6a38da5a36911baabfbef0ccf934847fcf7b51000197264c273d21430f7fea2`.
Its public-disabled precursor
`0474d566b14f446ecaf600e9112dfe6fcb002491c94f48f0e250ad96ccbfc3c1`
passed installed package verification. The two `config-full-1` matrices ran against the same corrected candidate; their
rejected evidence and subsequent valid full runs are recorded below.


## Complete behavioral runs rejected by evidence validation

Both `product-01521-config-full-1` and `product-01534-config-full-1`
completed all 20 cases with 189 assertions and verified cleanup against the
`a6a38da5...` candidate. Both exited incomplete because P13 created its role
snapshot before `identify()` resolved the primary participant. The final
validator correctly rejected `participantId: null`. These are complete behavioral
observations but are not valid product certificates; their original bytes remain
unchanged.

The first harness correction moved actual identity resolution before P13's
snapshot. Its additional global early guard also blocked P01, which deliberately
checks actual cwd before resolving ACC identity and then refreshes its record.
Scoped review found that regression; both `config-full-2` attempts confirmed it
at P01 and cleaned up. Commit `28117b3` limits the guard to P13; 17 focused
tests, the exact scope mutation and scoped re-review passed.

The first external P13 old-order mutation was confounded by that P01 failure;
it does not prove the intended P13 gate. Its diagnostic is retained, and the
checker now requires a passed P01 prerequisite before accepting a P13 mutation
result. A separate read-only process reconciliation at 09:22:36 UTC found no
Codex process whose cwd remained under the owned E2E/preflight roots; this does
not rewrite any historical cleanup receipt.


## Validated complete private product captures

`product-01521-config-full-3/evidence.json` and
`product-01534-config-full-3/evidence.json` each passed all 20 required scenarios
and 189 assertions with no failed case. Both runner processes exited 0, then an
independent `assertRunEvidence` invocation accepted both final records. Cleanup
records owned processes stopped and temporary state removed. Both name the same
reviewed implementation artifact:
`a6a38da5a36911baabfbef0ccf934847fcf7b51000197264c273d21430f7fea2`.
These are the first valid complete product certificates; earlier incomplete
records are retained without modification.

The corrected P13 mutation check first requires successful actual P01 setup.
`p13-record-mutant-01521-2/p13-record-check.json` then rejects the old snapshot
order at the P13 identity guard; `p13-record-positive-01534-2/p13-record-check.json`
passes the actual P13 record validator. Both clean up. The preceding `-1`
diagnostics were confounded by the P01 regression and are not mutation proof.

Independent `product-01521-config-cold-1` and
`product-01534-config-cold-1` runs also passed P01/P03/P06/P04, including 150
seconds without a hook heartbeat: 38 assertions and verified cleanup each.
They are intentionally partial full-matrix records; each selected scenario was
validated independently. The earlier public-artifact full runs supplied a third observation for that
runtime. After the final router correction, all three independent observations
per version were repeated on the corrected runtime, as recorded above.

## Public package and evidence gate

Public wiring is committed in `aad8ed0`; its scoped spec and quality review found
no Critical, Important or Minor issue. The runtime enables only the observed
native live-push path on darwin-arm64; new hook/lifecycle or native reply routing
claims were not added. Public documentation is in `9b95339`.

The first public candidate built from `aad8ed07af3f3f5608ec1578645d2a08e5bca3ea` is
`agents-can-communicate-0.3.1.tgz`, 273,141 bytes and 209 entries, SHA-256
`8dc730105b9a80c8245a7fc63392c1f7ded423ac538b3146d7dc5a83fde4e058`.
It passed actual installed-package verification. All 131 packed runtime files
under bin/src/plugin/skills are byte-identical to the tested private candidate;
there are no missing, added or changed runtime files. Documentation and
certification/provenance records differ intentionally.

Removing the actual referenced 0.152.1 full product evidence from an independently
unpacked/repacked candidate produced mutant SHA-256
`387b24c31f71aeb31375420c426851dda236d372767e0e50f9f25f3fc7789c3d`.
The positive package passed again, then the mutant failed at the exact
`certification fixture is missing` gate for the selected product evidence.
Temporary mutation state was removed.

Required `npm ci` passed; syntax checking covered 356 files. The first final
full suite ran 1,537 tests: 1,533 passed, two failed and two were skipped.
Both failures reproduce independently: a synthetic Codex binding without recorded
consent now correctly reports `delivery_disabled`, while the old acceptance test
expected a transport/version failure; a dry-run test expected obsolete prose.
Commits `6403e31` and `c175d64` corrected those two tests without runtime changes.
The no-consent case now asserts `delivery_disabled` and durable inbox retrieval;
the isolated dry-run case records that no app-server command launches. An
expected-value-only edit was rejected as mutation proof; the real launcher-argv
mutation proves the no-launch gate. The restored pre-router suite passed 1,535
of 1,537 tests with two existing conditional skips; its scoped review was clean.
Original failed logs remain retained. Final post-router counts are above.

## Final-review retirement race and corrected candidate

The single whole-branch review found one Important issue, with no Critical or
Minor findings. After selecting a fresh or refreshed binding, the router awaited
its final consent read and then checked only live session identity. A retirement
or same-generation endpoint replacement during that await left the old endpoint
eligible for an offer. A deterministic actual-core/in-memory reproduction showed
all four variants submitting to the obsolete endpoint and advancing its receipt.
Best-effort endpoint-file deletion cannot provide core retirement authority.

Commit `0aca9aeffef0af90baf49e9445bf925ae625172c` adds a final authoritative
eligible-binding query after policy/session awaits. It requires the selected
session, generation, adapter, client version and endpoint, live mode and a current
lease. Thirty promise-barrier tests pass, covering the reported variants and
mode/version/lease/generation changes. The old code and an exact removal of the
new gate each fail 26 protective cases; four already-safe controls still pass.
The restored covering router/core/boundary set passes 114 tests. This does not
claim atomicity with a vendor submission already in flight.

Both `product-01521-public-final-1/evidence.json` and
`product-01534-public-final-1/evidence.json` completed all 20 cases and 189
assertions, exited 0, passed independent full-record validation and verified
cleanup on the earlier `8dc73010...` artifact. They remain valid observations
of that earlier implementation, and cannot certify the changed router.

The corrected candidate
`945f6178357b6424a219b59cc3b9c4688b322c9da07cadf2bc7205bf20770940`
passed installed-package verification. Comparing it with `a6a38da5...` correctly
rejects runtime equivalence: exactly `delivery-router/src/router.mjs` changed
among 131 runtime files, with none added or missing. Fresh complete product
captures and independent cold runs therefore used this corrected candidate;
new primary evidence preserves previous positive and negative capture bytes.
Scoped final-fix review approved the correction with no remaining findings and
independently passed all 30 new tests. Both `product-01521-router-full-1` and
`product-01534-router-full-1` completed 20 cases / 189 assertions, exited 0 and
passed independent full-record validation with successful cleanup. Separate
`router-cold-1` runs passed P01/P03/P06/P04, 38 assertions and cleanup on each
version. Those intentionally partial records were validated by scenario.

The selected new `local-daemon-current-binding-product` fixture pairs copy these
complete corrected-runtime records byte-for-byte. Their new provenance records
hash earlier positive product captures, transport records and original remote
failure without modifying any previous file or record. A separate scoped data
and independent-audit review passed. The final artifact's complete matrices and
runtime equivalence then supplied each version's third independent corrected
cold/long-idle observation, with results linked above.

## Implementation decisions and their costs

These are the execution rulings, in the order recorded in the task ledger.
They remain visible here after local review scratch is removed.

| Decision | Basis | Cost if wrong |
|---|---|---|
| Use delegated implementation and scoped review despite the plan's inline note | The execution skill requires this workflow; product scope is unchanged | Additional process overhead |
| Drop unsupported install `--yes`; treat `/cd` support per observed launch mode; seed a normal prompt before testing idle addressability | Explicit delivery is noninteractive, ordinary and remote modes differ, and real SessionStart begins with a prompt | Rework setup and repeat captures; a virgin TUI remains unproven as an ACC recipient |
| Keep T04 limited to rejected submission plus a durable queued receipt | Direct transport observations do not establish the installed fallback route | Capture-schema and fixture migration |
| Allow metadata-only `thread/read(includeTurns:false)` for an already-loaded ID absent from a complete valid listing | Real first-turn hooks precede persisted thread/list metadata | Conservative degraded delivery and a required fresh client capture |
| Bound indeterminate retirement and carry one deadline through storage lock acquisition/publication | Hooks must fail open; a timed-out queued clear must not start later | Conservative delivery degradation until a later valid hook; an already-started write cannot be promised cancelled |
| Distinguish TUI detachment from actual thread teardown; resume/fork before explicit archive, then launch a fresh receiver | Both real versions retain loaded threads after terminal exit; real archive produces SessionEnd | Rework lifecycle E2E and keep capability disabled until the complete matrix passes |
| Preserve foreign TOML even when Codex inserts it inside ACC markers; fix the installer instead of re-trusting the test directory | Real client trust was present after P02 and deleted by P08 reinstall | Conservative install refusal or parser maintenance; foreign settings must never be silently discarded |
