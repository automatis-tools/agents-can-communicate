# Unreleased: a reused pid is no client, and a stuck pending update gives way

| Candidate artifact | Value |
|---|---|
| Built from | `2ff8cb9704616b0a3d93b83d8e030ff0bb528b9e` |
| Tarball | `agents-can-communicate-0.10.1.tgz`, 580,985 bytes, 351 files |
| sha256 | `7025372be6dcbdd67409781ae970d7387df1addfc280407ab0dbb3cbeaed91e5` |

Issues: #276, #277. Design:
[2026-10-06-reused-pids-and-stuck-pending](../design/2026-10-06-reused-pids-and-stuck-pending.md).

## What was measured before the change

On the maintainer's Mac on 2026-10-06, after 0.10.1 was published:

- `acc update` only retried the pending 0.10.0 and asked to restart the Codex app server. It
  did not look for 0.10.1. `acc update --pin none` cleared 0.10.0, and the next `acc update`
  staged 0.10.1; its refresh removed all 35 stale bindings without a pid.
- 0.10.1 then waited for 6 processes. Three were the real clients: this Claude Code session,
  another Claude Code session and the Codex app server. The other three were not ACC clients.
  `chrome-devtools-mcp`, which the Codex app server had started at 11:06, had pid 6462, the pid
  of a binding last written on 2026-09-30. Two IntelliJ Tailwind helpers had pids 37937 and
  39411, from bindings written on 2026-10-01 and 2026-10-05; the helpers started on 2026-10-05
  and 2026-10-06.

## What changed

- `cli/managed-runtime/activation.mjs`: `processStartedAt` reads a process's start time from
  `ps -o lstart=` with `LC_ALL=C`, or from WMI on Windows. A binding whose live pid belongs to a
  process that started more than a second after the binding was last written is no hold, and the
  same applies to the pid a session record names. `sweepStaleBindings` also removes such
  bindings, under the session's lifecycle lock. A binding whose pid is merely dead stays.
- `cli/managed-runtime/worker.mjs`: when the pending release reports `processes_active`,
  `performUpdate` looks for a newer release, at once for `acc update` and once a check is due
  for the automatic update. It stages a newer release in place of the pending one and tries the
  activation again.

## Tests

- New `managed-runtime-reused-pid.test.mjs`. A binding whose pid belongs to a process that
  started after the binding was written does not block. A client that started before, and an
  unreadable start time, keep it blocking. The sweep removes only the reused one. The test
  process's own start time is read within 5 seconds of what `process.uptime()` gives.
- New `managed-runtime-pending-supersede.test.mjs`. A blocked pending release is replaced
  through `acc update` and through a due automatic check, and not through a check that is not
  due. One that activates is kept, and so is one no older than the release found, which still
  reports `processes_active`: `acc update` asks to restart a client service from it. Three of
  these tests failed before the change. The packed manual-update check caught a first version
  that dropped that reason.

## Upgrade from the published 0.9.1

The published 0.9.1 was installed in isolation, as for the 0.10.1 release checks. A local
registry served archives of this tree, versioned 0.10.2 and 0.10.3.

- **A reused pid.** A binding was last written two days earlier; its pid belonged to a `sleep`
  started at the time of the run. The published 0.10.1, as a control, stayed pending:
  `waiting for 1 active or unidentified process(es): PID 82800 (native; 1 native binding; store
  contract 6)`. The archive of this tree was activated by the 0.9.1 updater: `Updated ACC to
  0.10.2; integrations refreshed.` The binding was removed and the store moved to contract 7.
- **A stuck pending release.** With 0.9.1's own `acc-mcp` holding contract 6, `acc update`
  staged 0.10.2, which waited for that process. The registry then offered 0.10.3, and `acc
  update` staged 0.10.3 in its place, which also waited. Once the server had exited, `acc
  update` printed `Updated ACC to 0.10.3; integrations refreshed.`, and only the 0.10.3
  generation remained.

## The maintainer's data home

Native holds that block a contract-7 activation, counted read-only on the live data home: the
0.10.1 code counted 9 bindings on 6 pids (6462, 36659, 37937, 39411, 76139, 87592); this tree
counts 6 bindings on 3 pids (36659, 76139, 87592), the real clients.
