# Task 6 current-binding evidence scoped review

Reviewed `4ec9e4f..85f347d` only: eight metadata/audit/new-fixture files and
the two current-capture documentation links. Runtime, router, adapter source,
final packaging, and final public-client matrix gates are outside this unit.

## Verdicts

| Area | Verdict |
| --- | --- |
| Spec compliance | PASS |
| Code quality | PASS |

Findings: Critical 0, Important 0, Minor 0.

## Spec review

- The two full evidence fixtures byte-match their supplied closed receipts:
  `72eac209e0007c617c51038b0e780de4fafe4601753e525172b09b480337295e`
  for 0.152.1 and
  `8aad29c7bf32098d12f3acb8d63fa18246e5feaf3d106de9c6eb32c7f1a7d562`
  for 0.153.4. Both state the reviewed candidate SHA-256
  `945f6178357b6424a219b59cc3b9c4688b322c9da07cadf2bc7205bf20770940`.
- The actual receipt facts agree with the selected summaries and provenance:
  0.152.1 finished at `2026-09-08T10:45:27.843Z`; 0.153.4 at
  `2026-09-08T10:45:35.663Z`. Each contains 20 scenarios, 189 assertions,
  20 passes, zero failures, and passed cleanup with owned processes stopped
  and temporary state removed.
- The manifest has exactly one selected darwin-arm64 `delivery.livePush` tuple
  for each captured version, each pointing to the corresponding new
  current-binding product summary and provenance record. Both new summary and
  evidence files are explicitly package-allowlisted.
- The new provenance records preserve all nine prior records exactly, append
  only the two current-binding records, and hash-link the preceding positive
  product evidence, transport summary/evidence, and remote-workspace failure.
- The independent audit names only `delivery.livePush`, preserves the exact
  0.147.0 hook/next-turn tier, and keeps native reply, lifecycle, guards, and
  uncaptured platforms unclaimed.
- The two current compatibility links select the new product captures while
  retaining the old captures as history, and accurately distinguish the
  deterministic router retirement regression from observed product-matrix
  cases. No source or runtime path appears in the reviewed diff.

## Quality review

The data changes are additive where history must be retained and replace only
the selected manifest/audit references. Hashes, timestamps, identifiers, and
limitations agree across summary, provenance, certification, and audit. The
documentation is precise about the current-binding correction without turning
the deterministic regression into an observation claim.

## Verification

- Validated both new product summaries with `validateCapture` and their full
  evidence with `assertRunEvidence`; each has the receipt facts stated above.
- Compared both published full-evidence files byte-for-byte with the supplied
  receipts and independently verified the candidate archive digest.
- Parsed the prior and current provenance files: prior record sequence is
  byte-equivalent (9 records), with exactly two appended records.
- Confirmed one selected tuple per version and the four exact new allowlist
  entries.
- Ran the scoped certification/package evidence set: 61 passed, 0 failed,
  0 skipped.
- Ran `git diff --check 4ec9e4f..85f347d`: clean.

No full suite, pack, packed missing-evidence mutation, runtime equivalence
check, or real client was run; those final gates are assigned to root.
