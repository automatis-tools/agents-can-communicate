# Unreleased: a zombie has exited, and doctor drops a failure its release outlived

| Candidate artifact | Value |
|---|---|
| Built from | `1dded551bd9c7e3288e4af2a3eebf9b866c6ac3f` |
| Tarball | `agents-can-communicate-0.10.2.tgz`, 582,379 bytes, 351 files |
| sha256 | `b2bfac02ed99ae8de51a5c076fc42d2307791da2fae158620c371afc0d17ea47` |

Issues: #280, #281. Design:
[2026-10-06-zombie-and-stale-maintenance](../design/2026-10-06-zombie-and-stale-maintenance.md).

## What was measured before the change

On the maintainer's Mac on 2026-10-06, with 0.10.2 pending and the Codex service restart
approved (`acc update --yes`):

- The maintenance job ran `codex app-server daemon stop`, and the daemon (pid 87592) exited. Its
  parent, `codex app-server daemon pid-update-loop` (started 2026-09-29), did not collect it:
  `ps` showed state `Z` and command `<defunct>`. The job moved to recovery with
  `daemon_death_unverified` and refused the restart, so the Codex service stayed down. The
  native bindings that named pid 87592 kept 0.10.2 pending until the pid-update-loop was stopped
  by hand.
- After 0.10.2 was active, `acc doctor` still printed `Update maintenance failed
  (processes_active); run acc update to retry.` The job record was `failed`, target 0.10.2.

## What changed

- `adapter-sdk/process-table.mjs`: `processIsZombie` reads `ps -o stat=` with `LC_ALL=C`. A state
  that starts with `Z` is a zombie; an empty or unreadable state gives `null` and decides
  nothing. Windows has no zombie state.
- `adapter-codex/maintenance-host.mjs`: a daemon that `ps` lists as `<defunct>` is dead.
- `cli/managed-runtime/activation.mjs`, `leases.mjs`, `pins.mjs`: a native binding, the pid a
  session record names, an ACC runtime lease and a pin stop holding when their process is a
  zombie. `sweepStaleBindings` removes zombie bindings under the session's lifecycle lock.
  `reclaimGenerations` reaps zombie leases and pins. Each pid is read once per pass; runtime
  admission does not run the check.
- `cli/managed-runtime/refresh.mjs`: the pending generation's refresh also removes zombie leases,
  as it removes the bindings an older activator still counts.
- `cli/managed-runtime/diagnostics.mjs`: with nothing pending, a failed or cancelled job whose
  target is the active generation is not reported. A completed job still is.

## Tests

- New `managed-runtime-zombie.test.mjs`. A zombie's binding and lease do not block activation,
  and the lease keeps no generation. A zombie's pin is reaped; a pin whose client state cannot
  be read keeps its generation. A live client and an unreadable state keep blocking. The sweep
  removes only the zombie's binding. With a real zombie, `listNativeHolds` gives no hold, and
  `prepareRefresh` removes its binding and lease while it keeps a live client's binding. Six of
  these seven tests failed before the change.
- `process-table.test.mjs`: a real zombie reads as one; a live process and a missing pid do not.
- Codex `maintenance.test.mjs`: a fixture daemon left `<defunct>` after the stop counts as stopped,
  and the start goes ahead. `maintenance-host.test.mjs`: the real host's `ps` output for a zombie
  reads as dead.
- `managed-runtime-maintenance.test.mjs`: a failed job, then activation of its release by another
  path, gives no maintenance report and the notice `ACC 0.4.4 is active.`; a failed job for a
  release still pending is reported; a cancelled one for the active release is not; a completed
  one is. Both tests failed before the change.

## Upgrade from the published 0.9.1

The published 0.9.1 was installed in isolation, as for the 0.10.2 release checks, with a
contract-6 store. A local registry served one archive. A native binding named a real zombie: a
shell started `sleep 0.1` and then exec'd into `sleep 900`, which never collected it (`ps`: state
`ZN`, command `<defunct>`). The zombie started a second before the binding was written, so the
reused-pid rule of #276 does not apply.

- **Control, the published 0.10.2** (sha256 `6e3d6350…`): `ACC 0.10.2 is ready; waiting for 1
  active or unidentified process(es): PID 64364 (native; 1 native binding; store contract 6).`
  0.10.2 stayed pending, and the store stayed on contract 6.
- **The archive of this tree**: `Updated ACC to 0.10.2; integrations refreshed.` The 0.9.1
  updater activated it while the zombie was still a zombie. The binding was removed, and the
  store moved to contract 7.

## The maintainer's data home

Read-only, on the live runtime, with 0.10.2 active and the job record from the morning still
`failed (processes_active)` for 0.10.2: the installed 0.10.2 doctor prints `Update maintenance
failed (processes_active); run acc update to retry.`; this tree's diagnostic gives `ACC 0.10.2 is
active.` and no maintenance report. No zombie runs on the machine now, so the holds were not
recounted.
