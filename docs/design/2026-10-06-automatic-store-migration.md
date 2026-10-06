# Automatic store migration on activation

Date: 2026-10-06. Follows #263 (store contract 7), decided before the 0.10.0 release.

## Problem

#263 made the move from store contract 6 to 7 an explicit command, `acc doctor --migrate-store`,
run once in each workspace. Automatic updates are on by default. After a managed update
activates a contract-7 runtime, every workspace still on contract 6 loses coordination:

- each hook fails open, and its remedy goes to stderr only, which Claude Code does not show for
  a successful hook;
- plain `acc doctor` reports the store's `protocol.json` as unreadable and the store as
  ambiguous, and does not name the migration command.

A user who did nothing but leave automatic updates on would stop seeing peers and not know why.
Measured on 2026-10-06 with the published 0.9.1 updated to the merge of #263.

## Decision

The new generation migrates every contract-6 store of its data home itself, as soon as it is
safe, and says so visibly when it cannot.

- **When it is safe.** Activation of a contract-7 runtime already waits until no live process
  holds contract 6: runtime leases and native bindings are its blockers. The same check, under
  the same admission mutex, guards each store's migration, exactly as
  `acc doctor --migrate-store` does.
- **Where it runs.** In the new generation's `reclaimAsActive`, which the activating process
  already imports from the activated generation right after the fence is released, and which
  the active generation's worker runs on its passes. The 0.9.x updater therefore triggers it
  without knowing about it.
- **One store at a time.** The admission mutex is taken per store, so entries wait at most one
  store's migration.
- **Retry.** The pass records `store-upgrade.json` beside `reclaim.json`. The scheduler starts a
  worker when the marker is missing or names another active generation, or when it is incomplete
  and a minute has passed. A store that stays blocked is retried until its blockers exit.
- **Visible when it cannot.** A hook that meets a contract-6 store still fails open. For Claude
  Code and Codex it also prints a `systemMessage` on session start and before a turn, which those
  clients show the user. Other clients keep the stderr line.
- **Doctor.** Plain `acc doctor` on a contract-6 store names the migration command instead of
  reporting the identity file as unreadable.

The explicit command stays for an operator who wants it now, or for a store the automatic pass
cannot reach.

## Launcher boundary

`schedule.mjs` is one of the modules copied into every launcher, which import only each other.
The retry check therefore lives there and reads only the marker; the migration itself stays in
`store-upgrade.mjs`, loaded by the worker. The first version imported the migration from the
scheduler, and a real Claude Code session showed every hook failing with
`ERR_MODULE_NOT_FOUND` from the launcher directory; a test now checks that every launcher module
imports only launcher modules. Because the scheduler knows no store contract, the worker records
the marker on every pass, also when it has nothing to migrate.

## Not changed

- Hooks never migrate a store; the migration runs in the worker or the activating process.
- Unmanaged direct users of a store (an npm-global or a development checkout without runtime
  admission) remain invisible to the blocker check, as they are to `--migrate-store`.
- There is no reverse migration.

## Verification

- Unit: the pass migrates every contract-6 store, skips contract 7, records blocked stores and
  leaves them untouched, and writes the marker; the scheduler starts a worker for a new or
  incomplete marker; doctor names the command; the Claude Code and Codex notices.
- Packed: the published 0.9.1 with contract-6 stores updates to the candidate, and its stores
  are on contract 7 after the update, with no command run by the user.
- Real: a copy of the maintainer's own data home migrates, with the time it takes.
