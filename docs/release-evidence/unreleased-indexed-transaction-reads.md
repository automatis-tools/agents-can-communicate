# Unreleased: bounded message and receipt transaction reads

Issue [#241](https://github.com/automatis-tools/agents-can-communicate/issues/241).

| Candidate artifact | Value |
|---|---|
| Built from | `ddc927ab8bc6dd71c15bda98d9bcbd20777f00bd` |
| Tarball | `agents-can-communicate-0.9.0.tgz`, 572,314 bytes, 349 files |
| sha256 | `33c33013eef12d476855745682f4a177cc92263613c8d723ac89b19eaf3dffc6` |
| Platform / runtime | macOS arm64, Node 24.4.0 |
| Capture | 2026-10-05 local / 2026-10-06 UTC |

This is an unpublished development archive. All packed changes were committed
before packing; its source tree was clean. The later evidence commit changes only
this document and CHANGELOG.md, neither of which is packed. Published release
records retain their original source and archive provenance.

## Read-cost observations

The same two-participant fixture with actual installed old/candidate modules
requires 500/1800/3900 primary reads for 20/40/60 sends before, versus
120/240/360 after. The warmed last send reads six primary records at all three
sizes. Candidate page publications at those sends are 4/6/6, with no index flush;
total send flushes remain eleven. Receipt read/offer/ack read 2/3/4 records instead
of 120/122/123 at the 60-message backlog. Reopened receipt reads two; reopened
retry reads seven. Forced cache rebuild is measured separately from warm use.

One quiet macOS pair took 4210.55 ms before and 3674.16 ms after for 60 sends.
Those timings describe the earlier measured private archive, not this final
archive or a whole-suite/Windows speedup. Final-code count guards passed again
after review fixes. Artifact identities, page/byte counts, mutation assertions
and raw descriptor measurements are documented in
[the implementation evidence](../internal/2026-10-05-indexed-transaction-evidence.md).

## Exact artifact verification

`node scripts/verify-package.mjs <archive>` passed on the archive above: all 349
entries allowed, six certification manifests, resolved packed documentation
links, fifteen bundled workspaces at 0.9.0, clean installation of all three
entrypoints, doctor reporting six adapters, a non-Git participant/claim, and
install/uninstall restoring client-home topology, modes, links and bytes. A
repeated uninstall made no change; runtime state did not land in the project.

## Real published predecessor and migration

The published 0.9.0 tarball has SHA-256
`df4700148f5710536155af47b05a0f211d5c8a5d09dee5c945e2b5a5303881c6`;
registry SHA-512 integrity matched too. Its actual binary created contract 6.
For managed-update testing only, a copy of final candidate metadata used version
0.9.99; its archive SHA-256 was
`3fbbd0810d842156bdebf1fd9d75b116f69c363fbadb2d6fde46743e9170d7f3`.
Repository versions were unchanged.

An actual managed old MCP responded to initialize and held a contract-6 PID
lease. Updating through the isolated local registry staged the verified new
code without activation; migration refused while the old process was alive.
After SIGTERM, process exit and ESRCH verification, explicit migration changed
6 to 7, preserved original message bytes, made zero registry requests and did
not activate. An unmanaged old binary refused a new open of the migrated store.
Explicit candidate activation then preserved retry identity and allowed ack.
This final-code installed-artifact test passed once in 11.54 seconds.

## Review and proof limits

One independent whole-branch review found three Important defects, no Critical
or Minor findings. Node 24 regressions failed before fixing duplicate prefix-ID
ordering, rejected async reads releasing the writer early, and process-exit
prune recovery omitting its POSIX directory fence. Process death after primary
and marker moves is tested; omission mutations reject both missing fences.

There is no observed Windows before/after result yet. Real process death and
actual flush ordering establish the recovery fence; no physical power-cut
experiment was performed. Management cannot prove an already-open unmanaged
library caller has stopped; the operator must quiesce those callers explicitly.
No new native-client capability or published release is claimed by this record.
