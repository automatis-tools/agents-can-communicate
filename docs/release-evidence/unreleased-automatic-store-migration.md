# Unreleased: older stores move to contract 7 by themselves

| Candidate artifact | Value |
|---|---|
| Built from | `0d79ea85cb2e8b13f9c2d30252bc81a05f110d50` |
| Tarball | `agents-can-communicate-0.9.1.tgz`, 576,270 bytes, 351 files |
| sha256 | `ff37f503eb3facfefd74404c6c7d68145ce67b21337428386f371803da79d2c9` |

Design: [2026-10-06-automatic-store-migration](../design/2026-10-06-automatic-store-migration.md).

## What was measured before the change

The published 0.9.1, isolated, with a contract-6 store, updated to a package of the merge of
#263 (versioned 0.10.0 for the managed runtime), 2026-10-06:

- `acc update` activated the new runtime.
- `acc status` answered "store contract 6 requires explicit migration: stop other store users and
  run acc doctor --migrate-store".
- Plain `acc doctor` answered "store state is ambiguous; repair is blocked. 1 unreadable:
  …/protocol.json". The file read fine and named `storeVersion: 6`.
- Claude Code's SessionStart and UserPromptSubmit hooks wrote "acc: coordination unavailable: store
  contract 6 requires explicit migration; … hook continued without context" to stderr and printed
  nothing on stdout.

## What changed

- `cli/managed-runtime/store-upgrade.mjs`: `migrateOlderStores` lists the data home's stores whose
  `protocol.json` names an older contract and its own workspace id, and migrates each under the
  admission mutex when the active generation speaks contract 7, admission is ready, and
  `listActivationBlockers` (strict native) finds no older holder. It records
  `store-upgrade.json` on every pass.
- `cli/managed-runtime/worker.mjs`: `reclaimAsActive` runs it after the reclaim, with the calling
  process's own lease ignored.
- `cli/managed-runtime/schedule.mjs`: the scheduler starts a worker when the marker is missing,
  names another active generation, or is incomplete and a minute old.
- `hook-runner`: on `store_migration_required`, an adapter's `failOpenNotice` renders stdout;
  Claude Code and Codex print `{"systemMessage": …}` on SessionStart and UserPromptSubmit.
- `storage-filesystem` and `cli` doctor: the diagnosis carries `migrationRequired`, and doctor
  names the migration command.
- `adapter-sdk`: `failOpenNotice` is an optional adapter function.
- Docs: UPGRADING's store contract section, the two compatibility records.

## Tests

The tests of the new behaviour were seen failing before the change, except where noted.

- `packages/cli/test/managed-runtime-store-upgrade.test.mjs`: every older store migrates and the
  pass is complete; a live older lease blocks it and the pass stays open; the activating process's
  own lease does not; an older generation migrates nothing but records the pass; one failing store
  does not stop the others; the scheduler's due rule.
- `packages/cli/test/doctor-store-migration.test.mjs`: plain doctor names the command (failed on
  main's doctor).
- `packages/cli/test/managed-runtime-launcher-modules.test.mjs`: every launcher module imports
  only launcher modules (fails when `schedule.mjs` imports `store-upgrade.mjs`).
- `packages/cli/test/managed-runtime-worker.test.mjs`: the reclaim scheduling test now also needs
  the store-upgrade marker before nothing is due.
- `tests/acceptance/store-migration-packed.test.mjs`: the packed update moves an older store by
  itself (failed without the worker change); the hook's stdout carries the systemMessage.

## End to end

- **Claude Code 2.1.289**, real terminal, model stub, packed candidate, a contract-6 store held by
  a live older binding. The first candidate's hooks all failed with `ERR_MODULE_NOT_FOUND` from the
  launcher directory, because `schedule.mjs` imported the migration module, which the launchers do
  not copy. After the fix, the terminal showed "SessionStart:startup says: ACC: coordination is
  paused in this workspace until its store moves to the new format. … acc doctor --migrate-store",
  no hook error, and the held store stayed on contract 6.
- **Codex 0.160.1**, `codex exec`, model stub, the same held store: SessionStart and
  UserPromptSubmit reported `Completed` with ACC's output and the turn ran. Exec mode prints no
  systemMessage.

## On a copy of the maintainer's data home

42 contract-6 stores, 102 MB, copied from the maintainer's own data home, 2026-10-06, with a
managed control naming a contract-7 active generation:

- With the stores' bindings as they were, all 42 stayed on contract 6 as `blocked`: the bindings
  named the maintainer's live Claude Code and Codex sessions. The same holds block the activation
  of a contract-7 runtime, so on a real update this pass runs only after they exit.
- With the bindings removed, all 42 migrated in 4.7 s: median 13 ms, the slowest two 1.1 s each.
  The admission mutex is held for one store at a time, so a hook waits at most about a second,
  and one that arrives during the slowest store fails open once.

## Limits

- Codex's TUI display of this plain systemMessage shape was not measured; the field's display was
  measured on 0.147.0, 0.155.1 and 0.159.1 with `hookSpecificOutput` beside it.
- Unmanaged direct users of a store are invisible to the blocker check, as for the explicit
  command.
- The migration of a large store holds the admission mutex for its duration (1.1 s for the
  largest of the maintainer's stores).
