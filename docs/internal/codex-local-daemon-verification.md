# Codex LocalDaemon implementation and verification

Work in progress on `feat/codex-local-daemon`; this report is not a release certificate.
Public native delivery remains disabled until the full installed matrix and final
artifact gates pass. Nothing has been pushed, merged, published, or posted to GitHub.

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

## Results recorded so far

The reviewed transport matrix passed on Codex 0.152.1 and 0.153.4, macOS arm64:
four cases and 15 assertions per version. It checks exact B binding, same-thread
rejection with A cwd, idle queue acceptance, pending busy delivery and rejected
submission with a durable queued receipt. Product baseline, long idle, busy and exact receiver cases
have passed; the complete P01-P20 product matrix is still being executed.

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
will be appended after completion.


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
values. The actual policy mismatch is being diagnosed separately. Both failed
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
with verified cleanup. Real `thread/archive` API diagnostics now test actual
server teardown and generated hooks separately; no successful UI archive is
claimed. The new private package is
`b8eb1bee2296746953b3929ef37b45434588264736f756ac9811f5b80107b300`,
packed after the runtime fixes, and remains non-release-certifiable until the
complete product matrix passes.

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
uninstall; implementation and focused mutation tests are in progress.

The reviewed lifecycle harness (`c6dfd4e`) now requires the actual archive
confirmation, exact `SessionEnd`, unloaded thread, retired binding and a queued
actionable question before starting a fresh receiver. Its 16 focused tests and
three exact mutations passed, with clean scoped review. The full matrix remains
uncertified while the config-preservation fix and actual UI checks complete.


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
is not yet considered review-complete.

The new public-disabled tarball, SHA-256
`8b8fc8012c8f28f41755922ad08131ff1140c0352bab30d54b8d6b2b0395d634`,
passed installed-package verification. The corresponding private runtime candidate
is `1a903ae79414355e460b975b3f90fbdf4f46633366f147080f833e0f1ec1cc49`.
New real trust-preservation and full-product runs are in progress on that artifact;
no outcome is inferred from the focused tests or package check.
