# Reused pids and a pending update that cannot activate

Date: 2026-10-06. Issues #276 and #277. Ships in 0.10.2.

## Problem

After 0.10.1 removed the stale bindings without a pid (#273), the maintainer's Mac still could
not activate it:

- **Reused pids (#276).** Of the 6 processes holding 0.10.1, 3 were not ACC clients.
  `chrome-devtools-mcp` (started by the Codex app server) and two IntelliJ Tailwind helpers had
  taken the pids of Claude Code sessions from 2026-09-30, 2026-10-01 and 2026-10-05. The hold
  asked only whether the pid existed.
- **A stuck pending release (#277).** With 0.10.0 pending, the updater only retried it; it never
  looked for a newer release. 0.10.1 reached the machine only after `acc update --pin none`
  cleared 0.10.0.

## Decision

- **A client runs when it writes its binding.** A binding whose pid now belongs to a process that
  started after the binding was last written is not held by its client. The start time comes
  from `ps -o lstart=` with `LC_ALL=C`, or from WMI on Windows; one second of slack covers
  `ps`'s whole seconds and a filesystem's. A start time that cannot be read decides nothing,
  and the binding keeps holding. The same check applies to the pid a session record names.
- **The pending generation's refresh removes those bindings**, as it removes the stale ones of
  #273, because an older generation activates with its own rule. A binding whose pid is merely
  dead stays: no activator counts it, and a resumed conversation finds it.
- **A newer release replaces a pending one that cannot activate.** When the pending release
  reports `processes_active`, `acc update` looks for a newer release at once, and the automatic
  update does so once a check is due; a newer one is staged in its place and activation is tried
  again. A pending release that activates, or a failure of another kind, is left as it is.

## Reach

`acc update` runs the newest installed generation, so the pending one. A machine already
holding a pending 0.10.0 or 0.10.1 still runs their rule and needs `acc update --pin none` once;
`docs/UPGRADING.md` says so. From 0.10.2 on, the update does it by itself.

## Verification

- Unit: a reused pid stops holding and is swept; a client that started before its binding was
  written, and a start time that cannot be read, keep holding; the start time of the test
  process is read on every platform. A blocked pending release is replaced through `acc update`
  and through a due automatic check; one that activates, or a release no newer than it, is kept.
- The maintainer's data home, read-only: with this rule, the holders are the 3 real clients.
