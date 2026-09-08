Implemented adapter-local fallback only for zero listed matches. All existing loaded/page/cwd/status checks remain. First new test failed before implementation.23 focused protocol/native/process tests passed (metadata-integration.log). Mutations includeTurns:true, omittedIDequality and omittedemptyturns gate allcaught in /private/tmp/acc-codex-implementation/mutant-metadata-*.log. Real candidate0.152.1 P01passed10assertions, exactdaemonA/pwdB/hookB/workspaceB/installedbindingversionandPID (product-01521-base-2 incomplete-evidence.json); laterP02stoppedatsecondclientTUIreadiness before delivery, so no full product claim. Priorcloseddiagnostic showed thread_not_found during bothfirsthooks although serverqueueprobe,PID,version andconsentcorrect. Source0.152.1 /private/tmp/acc-42457-thread-processor-01521.rs lines2837-2885 explicitlybuildsloadedmetadata snapshotwithoutturns beforepersistence. Publicadapterdescriptorstilldisabled.

## Malformed-list follow-up

Review found that the first-turn fallback treated `thread/list` entries such as `null`
as nonmatches. The pagination helper proved only that `data` was an array; optional chaining in
the identity filter then turned malformed elements into a zero-match list and allowed
`thread/read`.

The adapter now validates every listed element as a non-array object with a non-empty string
`id` before counting matches. This is deliberately narrower than validating cwd or status at
the list boundary: existing target-row cwd mismatch and non-live status behavior still returns
the established closed refusal, while malformed identity structure is a protocol error.

The new test was observed failing first with `[null]`. It also mutates entries to `{}`, an empty
ID, a scalar, and an array, requiring `EPROTOCOL` and zero `thread/read` calls in every case.
The existing duplicate-target test still proves duplicates refuse without metadata fallback.

Focused verification after the fix:

```text
node --test packages/adapter-codex/test/app-server-client.test.mjs \
  packages/adapter-codex/test/app-server-validation.test.mjs \
  packages/adapter-codex/test/native-delivery.test.mjs

22 tests passed, 0 failed
```
