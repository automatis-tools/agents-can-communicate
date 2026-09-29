# Unreleased: a reclaim the updating process held back is retried

A follow-up to #208, found in the 0.8.5 upgrade preflight.

## What was measured

On 2026-09-29, the published 0.8.4, installed from npm into an isolated prefix with its own
`HOME`, data home and project, updated itself through a local registry to the 0.8.5 release
candidate. Right after the update, `reclaim.json` named the 0.8.5 generation with
`complete: true`, but the 0.8.4 generation was still there. It stayed through an `acc status`
from npm's `acc` and one through ACC's own launcher, and no later command started a worker,
because the marker said the pass was done.

The update runs from the 0.8.4 generation and holds a runtime lease on it. Since #228 it runs the
activated generation's reclaim in the same process, so that pass always finds its own lease on
0.8.4 and keeps it. With automatic updates on, the next update check's worker would remove it;
with them off, it stayed until the next update.

## What changed

`packages/cli/src/managed-runtime/worker.mjs`: after its reclaim, `reclaimAsActive` looks for a
lease of its own process on a generation other than the active one. When it finds one, the pass
is recorded as unfinished (`complete: false`), as a postponed pass is. The scheduler's hourly
retry then starts the worker from the next ACC command an hour or more later, when the updating
process has exited. A worker started at once was tried first. It made every command right after
an update race that worker for the manager lock: in the packed managed-update checks, two tests
failed and one test file hung for twenty minutes. The hourly retry avoids that race.
`docs/ARCHITECTURE.md` describes the pass.

## Tests

`packages/cli/test/managed-runtime-worker.test.mjs`:

- A reclaim that the process's own lease held back is unfinished, starts no worker right away,
  and is due an hour later. It failed before the change.
- A reclaim that only another live process held back stays complete.

The 24 packed managed-update checks passed on the change, in 77 seconds under `env -i`.

## The update, measured again

The same preflight on a 0.8.5-versioned copy of the change: right after the update the marker
said `complete: false` and both generations were kept; npm's `acc status` and the launcher's
started no worker. With `attemptedAt` moved two hours back, the next launcher `acc status`
started the worker, which removed the 0.8.4 generation and recorded `complete: true`.

## Suite

`npm test` on `e115212`, under `env -i` with only `HOME`, `USER`, `TMPDIR` and a PATH of system
directories plus node, as in CI: 2,795 tests, 2,794 passing, 0 failing, 1 skipped (the existing
uninstall check that skips on a machine where Gemini CLI is installed), in 9.1 minutes.
