# Unreleased: the Codex daemon a new home installs, and reclaim on the release that fixes it

## What was measured

**#205.** On 2026-09-29 (macOS arm64, Codex CLI 0.159.0), `codex app-server daemon start` in a
fresh temporary `CODEX_HOME` installed the daemon's own package from the CLI in about two
seconds, with no download: `packages/app-server-daemon/releases/0.159.0-aarch64-apple-darwin/`
with `bin/codex`, and `current` linking it. The daemon kept its PID in
`app-server-daemon/daemon.pid`, in the same JSON as the standalone `app-server.pid`, ran as
`<home>/packages/app-server-daemon/releases/<release>/bin/codex app-server --listen unix:// --managed-daemon`,
and `daemon version` reported `managedCodexPath`
`<home>/packages/app-server-daemon/current/bin/codex`. The control socket was the usual symlink.
A SIGTERM left `daemon.pid` and removed the symlink; the next start reused the package. ACC
looked only for the standalone package, so such a home got the standalone download prerequisite
and its daemon's pid could not be proven.

**#208.** Measured on the maintainer's machine during the 0.8.0 to 0.8.1 update (2026-09-27): an
update is run by the newest installed implementation, so the activation of 0.8.1 and the reclaim
after it ran 0.8.0's rule, and two pid-less pins with their generations survived until the next
release, although the fix was already active.

## What changed

- `packages/adapter-codex/src/maintenance-host.mjs`: `maintenanceContext` resolves the layout
  from the package that exists, the standalone one first, and returns the managed executable,
  the PID record and the package tree the daemon's executable must live in. Maintenance,
  service setup and discovery all read these.
- `packages/adapter-codex/src/service-setup.mjs`: a home with no package on a CLI of 0.157.1 or
  newer is planned as starting the service (`selfInstall`), with doctor's launch advice when
  `daemon_auto_start` is on; setup starts it and then verifies the installed package and daemon
  as any existing service. Older CLIs keep the standalone download.
- `packages/cli/src/managed-runtime/worker.mjs`, `schedule.mjs`, `bin/acc-update-worker.mjs`:
  the worker passes its own generation root; after each pass, the active generation's worker
  reclaims with its own rule and records `reclaim.json` naming that root. The scheduler starts a
  worker when that record is missing or names another root, regardless of the update opt-out
  or the no-network override. A reclaim that finds an unknown holder still postpones itself.

## Tests

- `packages/adapter-codex/test/self-installed-layout.test.mjs`: the paths follow the installed
  package; a self-installed service is inspected `ready` by its own identity; discovery proves
  its daemon and finds its chats; a new home on 0.159.0 is planned and started with no download;
  a new home on 0.157.0 still needs the standalone package. The first four failed before the
  change. The maintenance fixture gained a self-installed layout whose start installs the package.
- `packages/cli/test/managed-runtime-worker.test.mjs`: the active generation's worker reclaims an
  unreferenced generation and records it; a worker that is not the active generation reclaims
  nothing; the scheduler starts a worker for a generation that has not reclaimed, and not once
  it has. The first and third failed before the change.

## Real Codex

With this change against real temporary homes: the self-installed daemon from the capture was
resolved as that layout, its pid was proven with `ps` and `lsof`, and it was inspected `ready`
for maintenance and for setup. A second fresh home was planned as a start with no download and
with the launch advice, then started by the setup through the real `daemon start` and verified
`ready`. The maintainer's own home still resolved to the standalone layout. Both temporary homes,
their daemons and helper processes were removed afterwards.

## Exact local artifact

- Source: clean commit `34d644859a73334b3b5bcb6c8193eb2cf7d42d88` on
  `fix/reclaim-and-codex-daemon-layout`, from `main` at `f9937e7`.
- Archive: `agents-can-communicate-0.8.3.tgz`, packed from that commit.
- Size: 495,172 bytes; 318 packed entries.
- SHA-256: `2cb234368acc38a6695f8a671bcb064fee3a1c4d2491fe4f65307bcf0f22f6cb`.
- Package version remains `0.8.3`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
