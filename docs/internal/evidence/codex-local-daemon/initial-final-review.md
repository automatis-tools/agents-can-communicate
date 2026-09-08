# Whole-branch review: Codex LocalDaemon

Reviewed range: `a059e56..c175d64416241ce261de0daf0c2d0135c4cee68c`.
Review basis: final-review-brief.md, final-review-state.md, the design spec,
implementation plan, permanent verification report, full-range split diffs,
resulting source, scoped-review/mutation records, and closed real evidence.

**Spec compliance: CHANGES REQUIRED.**
**Code quality: CHANGES REQUIRED.**
**Findings: 0 Critical, 1 Important, 0 Minor.**

The final public real-client matrices remain pending at this review's completion.
This review does not certify their result. Even a subsequent pass on public
artifact `8dc73010...` does not certify the runtime correction required below.

## Important: final consent read can outlive binding retirement or replacement

Location: `packages/delivery-router/src/router.mjs:118`, especially the final
session-only check at lines 124–130 and transport call at line 136.

The router awaits `policyFor()` after selecting its binding (and, for expiry,
after its post-refresh binding re-read). That await can overlap a hook's
`clearDeliveryBinding()` or a same-generation re-handshake. The subsequent
`listLiveSessions()` check validates the session/generation, but does not validate
whether the selected binding is still non-retired or still the current endpoint.
It then offers using the stale binding snapshot.

This is reproducible with the actual core service and in-memory store, without
clients, filesystem timing assumptions, or fake receipt commits. Execute from
the worktree:

```sh
node .superpowers/sdd/2026-09-07-codex-local-daemon/final-review-repro.mjs
```

The reproduction performs the state transition inside the second policy-read
callback, before that callback returns `actionable`. All four cases currently
call the adapter and produce `offered`:

| Initial binding | Concurrent transition | Current core binding at offer | Offered endpoint |
|---|---|---|---|
| Fresh | Retire | `retiredAt` set | `endpoint_original` |
| Fresh | Replace within same generation | `endpoint_successor` | `endpoint_original` |
| Expired, successfully refreshed | Retire | `retiredAt` set | `endpoint_original` |
| Expired, successfully refreshed | Replace within same generation | `endpoint_successor` | `endpoint_original` |

The effect is an unauthorized-by-current-reachability native submission after
core has retired the endpoint, or submission to a superseded endpoint. Codex's
final thread/version/cwd validation cannot discover core retirement, and adapter
metadata removal is explicitly best effort. A retained endpoint may still name
a genuinely loaded thread and pass all vendor identity checks. The receipt can
advance to offered as well: this reproduction uses real core receipt handling.

Re-read eligible bindings after the final awaited policy/session checks and
immediately before transport. Require the selected session, generation, adapter,
client version, endpoint, live mode, and an unexpired, non-retired current binding.
If retirement or replacement intervened, retain the queued receipt and make zero
adapter calls. Add barrier regressions for fresh and refreshed bindings, including
both retirement and same-generation replacement. Prove the new gate by removing
it and observing those exact zero-offer/queued assertions fail. The diagnostic
script deliberately asserts today's bad behavior; it is not a protective test.

This asks for the spec's final current-binding check, not atomicity across a
local transaction and vendor queue acceptance. The documented limit on an offer
already in flight remains appropriate.

## Cross-branch/spec assessment

- Consent is persisted independently of probe eligibility, with strict present-field
  precedence, legacy fallback, and off on read failure. CLI/MCP roots use their
  resolved data home. Codex hooks and installed skill commands pin that data home;
  policy itself is reread. Bootstrap-environment adapters retain their old policy
  source. The race above is separate from the correctly handled consent revocation.
- Receiver identity is adapter-owned metadata with opaque random IDs, bounded private
  records, no-follow/nonblocking reads, socket checks, exact loaded thread selection,
  canonical cwd, server/version verification, and same-connection preflight/add.
  The sender's CODEX_HOME does not select the receiver socket. Metadata-only
  first-turn fallback explicitly excludes turns, and production RPC connections
  discard unsolicited notifications. Public delivery diagnostics remain closed.
- Core remains vendor-neutral. Expired binding queries are opt-in, generation and
  retirement filtering remains in core, refresh uses the existing mutation rather
  than republishing, and presence is not spoofed. Hook retirement carries a shared
  deadline through storage acquisition/publication and endpoint-scoped cleanup.
  These mechanisms do not close the later router race described above.
- Codex activation reuses a pre-existing service with null lifecycle commands and
  no launch wrapper. Legacy reconciliation preserves modified wrappers and their
  cleanup authority, shared Claude/PATH artifacts, and pre-existing daemons.
  Codex TOML ownership scanning preserves foreign declarations inside markers and
  refuses ambiguous owned content before plugin writes. No additional integration
  defect was identified in installation, upgrade or uninstall.
- The implementation retains durable-before-offer behavior and monotonic receipts.
  Pending queue deduplication is explicitly narrower than exactly-once execution.
  Native replyRoute remains false, hook/next-turn certification stays exact-version,
  and darwin-arm64 is the only native platform declared. No coordinator, runtime
  daemon, target launcher, transcript collection, Git requirement, runtime dependency,
  or repository runtime-state feature was introduced.
- The harness installs tarballs into isolated prefixes, verifies executable/skill/hook
  targets, uses installed ACC as the product stimulus, verifies actual markers and
  busy ordering, exercises an uninstrumented path, and owns temporary client/daemon
  teardown. Product P14 now performs actual UI archive confirmation and observes
  SessionEnd/unloaded state. Failed/partial attempts and source-only lifecycle
  observations are distinguished from complete certificates.

## The seven execution rulings

| Ruling | Assessment against product requirements |
|---|---|
| Delegated implementation/scoped review despite the original inline plan note | Process-only change; no coordinator or managed runtime subsystem was added. No product-spec exception results. |
| Drop unsupported `--yes`, observe `/cd` by launch mode, and seed the first normal prompt | Consistent with actual client prerequisites. The virgin, never-submitted TUI remains unproven; no capability is inferred for it. |
| Limit T04 to rejected submission and queued receipt | Correctly avoids treating transport-method capture as installed routing proof. Product certification independently requires the full matrix. |
| Exact loaded-ID metadata-only `thread/read(includeTurns:false)` fallback | Bounded adapter-local correction; only zero valid listed matches enter fallback, and ID/cwd/live status/empty turns remain checked. No history request is introduced. |
| Shared retirement deadline and bounded indeterminate refusal | Matches fail-open behavior and prevents queued clears beginning after their deadline. Already-started filesystem writes are accurately excluded from cancellation promises. Router finding above still needs correction. |
| Distinguish TUI detach from thread teardown; resume/fork before archive | Matches the two clients' recorded behavior. Archive supplies a real teardown event; detached execution and source-described eventual unloading remain explicit limitations. |
| Preserve foreign TOML inserted inside ACC markers | Required preservation correction, supported by the actual trust-loss reproduction. Conservative refusal of ambiguous ownership is appropriate; test re-trusting would have hidden the defect. |

## Gate and artifact evidence

I inspected the actual final full-suite log: 1,537 tests, 1,535 passed, zero
failures, two existing skips. The supplied state records npm ci, 356-file syntax,
pack/installed verification and diff checks passing. I did not rerun these broad
gates or launch real clients during this review.

I independently ran the closed validators for both shipped product records:
20 cases, 189 assertions and successful cleanup per version. Their bytes exactly
match `product-01521-config-full-3/evidence.json` and
`product-01534-config-full-3/evidence.json`; fixture hashes are respectively
`1a53d02db21a472ba7e8b37cca3d935826a3e1a17a8c17223dc56ecbebac1e21`
and `81ff85c16e7320df233d353267bf216dc2c40ee5b86ccbcc2e2fe754e2e99591`.
Both product capture validators and both narrow transport capture validators pass.
The public/private equivalence receipt reports 131 runtime files and zero
missing, added, or changed files. Certification/provenance differs intentionally.

Mutation coverage was checked against the plan and task/follow-up records,
including consent precedence/off retirement/data-home pinning, launch wiring,
legacy ownership, exact receiver/cwd/socket/protocol behavior, metadata privacy,
expiry/retirement/generation checks, retirement deadlines, foreign TOML, harness
identity/cleanup, and certification association. The task 1 and task 2/3 original
mutation logs contain behavioral assertion failures, rather than only syntax
failures. Existing task 4 post-refresh mutations protect the earlier read; they
do not protect the later asynchronous gap found here.

The real packed remote-wrapper, wrong-thread and cwd-check mutation receipts name
the exact intended failing assertions and report cleanup pass. The public
missing-selected-product-evidence mutant records positive verification first,
then rejection at the precise missing fixture path. Historical failure fixtures
remain present; the package audit binds passing Codex claims to their selected
full product evidence and validates its digest and package/version/platform.
The confounded initial P13 mutation is explicitly excluded, and the later
prerequisite-checked diagnostic supplies the replacement proof. No additional
open mutation-evidence finding was identified.

## Completion boundary

Root owns the two running final public matrices and their cleanup. Preserve their
actual outcomes against `8dc730105b9a80c8245a7fc63392c1f7ded423ac538b3146d7dc5a83fde4e058`.
After correcting the Important finding, perform the scoped fix review, exact
regression mutation and required final artifact gates. Runtime changes require
fresh installed product evidence; the present public/private byte-equivalence
receipt cannot establish equivalence for a changed router. Update the permanent
WIP report and remaining plan gates only from those actual results.

Only this report and its ignored diagnostic were written by this reviewer.
No shipped source, tests, fixtures, index or HEAD were changed; no broad suite,
real client, personal configuration, push, merge, release or external posting was used.
