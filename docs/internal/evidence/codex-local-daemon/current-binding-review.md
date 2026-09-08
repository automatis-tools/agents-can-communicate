# Scoped final-fix re-review

Range: `c175d64416241ce261de0daf0c2d0135c4cee68c..0aca9aeffef0af90baf49e9445bf925ae625172c`.
Scope: the original Important current-binding race and new breakage introduced
by the two-file correction. This is not a second whole-branch review.

**Original finding: ADDRESSED.**
**Spec compliance: APPROVED within this scope.**
**Code quality: APPROVED within this scope.**
**Remaining/new findings: 0 Critical, 0 Important, 0 Minor.**

`packages/delivery-router/src/router.mjs:134` now queries authoritative eligible
bindings after the final awaited policy and session checks. It requires the
selected session, generation, adapter, client version and opaque endpoint to
remain current, with livePush and a still-future lease. The core query supplies
retirement/current-generation filtering. Transport receives the returned current
binding rather than the stale selected snapshot, while retaining the final
policy result. No further policy/session await intervenes before transport.
Retirement or replacement during either prior awaited boundary therefore leaves
the receipt queued and invokes no adapter.

The correction retains the existing ambiguity checks, refresh path, policy
sources and receipt handling. It does not add core/vendor coupling or pretend
to make local state checks atomic with vendor queue acceptance. No new scoped
breakage was identified.

## Verification

I read the exact two-file diff, implementation report and original reproduction.
I independently ran:

```sh
node --test packages/delivery-router/test/router-current-binding.test.mjs
```

Result: **30 passed, 0 failed, 0 skipped**, process exit 0. Tests use the actual
core service and in-memory store with explicit promise barriers; no filesystem
speed or real-client timing assumptions are involved. They cover fresh and
refreshed binding retirement, endpoint/adapter/version replacement, mode removal,
lease expiry and generation replacement at the final policy/session boundaries.
The original four failure cases assert zero adapter calls, durable queued
outcome, queued receipt and no offer-success event. Fresh/refreshed controls
still offer successfully.

I inspected `final-fix-mutation.log`: removal of the new gate restores 26 exact
behavioral failures, with one adapter call, offered result, offered receipt and
an offer-success event where zero/queued was required. Four existing controls
or earlier generation checks still pass. `final-fix-red.log` records the same
4-pass/26-fail baseline; `final-fix-green.log` records restored 30/30 passing.
`final-fix-focused.log` records **114 passed, 0 failed, 0 skipped**, including
the surrounding router/core/session/package-boundary coverage. I did not rerun
the broader covering set, full suite, mutations or real clients.

The inspected checkout was clean at `0aca9aeffef0af90baf49e9445bf925ae625172c`.
Only this ignored review report was written; source, index and HEAD are unchanged.

## Remaining completion boundary

The source finding is resolved. Root still owns corrected-runtime packing,
both real-client recaptures, updated evidence/package association and the final
artifact gates. Previous `8dc73010...` client observations and runtime-equivalence
receipts do not certify this changed router. This scoped approval makes no claim
that those outstanding product gates have completed.
