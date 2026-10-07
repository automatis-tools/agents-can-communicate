# Zombie processes and a settled maintenance failure

Date: 2026-10-06. Issues #280 and #281. Ships in 0.10.3.

## Problem

With 0.10.2 pending on the maintainer's Mac and the Codex service restart approved
(`acc update --yes`):

- **A zombie counted as alive (#280).** The maintenance job ran `codex app-server daemon stop`.
  The daemon (pid 87592) exited, but its parent, `codex app-server daemon pid-update-loop`
  (started 2026-09-29), did not collect it. `kill(pid, 0)` succeeds for a zombie, and `ps` still
  prints its start time, so the job could not confirm the stop: it moved to recovery with
  `daemon_death_unverified` and refused the restart. The Codex service stayed down, and the
  native bindings naming pid 87592 kept 0.10.2 pending. The update finished only after the
  pid-update-loop was stopped by hand.
- **A settled failure stayed on screen (#281).** The job ended `failed` (`processes_active`).
  A later `acc update` activated 0.10.2, yet `acc doctor` still printed
  `Update maintenance failed (processes_active); run acc update to retry.`

## Decision

- **A zombie has exited.** `processIsZombie` (adapter SDK) reads `ps -o stat=` with `LC_ALL=C`; a
  state that starts with `Z` is a zombie. An empty or unreadable state decides nothing, so the
  process keeps counting as alive. Windows has no zombie state.
- **Where it applies.** A native binding, the pid a session record names, an ACC runtime lease,
  and a pin: each stops holding when its process is a zombie, as when it is dead. A decision
  reads each pid once per pass. Runtime admission does not run the check, so a hook spawns no
  extra process.
- **Older activators.** The pending generation's refresh already removes the bindings an older
  activator still counts (#273, #276). It now also removes zombie bindings and zombie leases,
  so 0.10.2 activating 0.10.3 does not wait for them.
- **Codex maintenance.** The service host reads the daemon as `<defunct>` in `ps -o command=` after
  the stop; that is a dead daemon, so the stop is confirmed and the start goes ahead.
- **A failed or cancelled job for the active release is history.** When nothing is pending and
  the job's target is the active generation, doctor no longer reports it. A completed job still
  reports its restart, and a failed job whose release is still pending is reported as before.

## Verification

- Unit: a zombie's binding, lease and pin hold nothing, and the sweep removes the binding; a live
  client and an unreadable state keep holding. A real zombie (`sh -c 'sleep 0.1 & …; exec sleep
  5'`) reads as one through `ps`, gives no native hold, and the pending generation's refresh
  removes its binding and lease. The Codex fixture daemon left `<defunct>` after the stop
  restarts; the real host's `ps` output for a zombie reads as dead.
- Doctor: a failed job, then activation of its release by another path, gives no maintenance
  report; a cancelled one likewise; a completed one is still reported.
