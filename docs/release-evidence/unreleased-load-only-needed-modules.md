# Unreleased — load only the modules a command needs

This development candidate implements #270: an ACC command, indicator read or hook
loads the modules it runs and the adapters of the clients it serves. It is not a
published release. The package still declares version 0.11.0; these candidate bytes
differ from the published 0.11.0 artifact, whose original record remains unchanged.

## Source and artifact

| Fact | Value |
|---|---|
| Source commit | `955fe94267a373eadcc9e3e1fa50540d2d009f4a` |
| Source state at pack time | clean feature worktree |
| Archive | `agents-can-communicate-0.11.0.tgz` |
| Archive size | 610,227 bytes |
| Packed files | 376 |
| SHA-256 | `a01304320bb1f2100be8244fc5a1a3cc4864f2f6b2b8ac3a3bb05a4d19e3e769` |
| Local environment | macOS, Node 26.5.1 |

`node scripts/verify-package.mjs` passed on the clean worktree and reported the same
digest as a separate `npm pack`.

## Cause

Every `acc` command started from `bin/entrypoints/acc.mjs`, which imported the CLI
index, the delivery router, the installer and the hook runner before it parsed a word.
The CLI index re-exported `install-command.mjs`, which constructs all six client
adapters, and `help.mjs` built its list of adapter ids the same way. The indicator
looked up its client's adapter in that list too. A module loader that records each
resolved file, run against main at `e03124fb` with an isolated data home, counted:

| Entry point | Modules | Client adapters |
|---|---|---|
| `acc version` | 234 | all six |
| `acc help` | 234 | all six |
| `acc status` | 234 | all six |
| `acc-indicator --adapter claude_code --json` | 199 | all six |
| `acc-hook claude_code beforeTurn` | 136 | Claude Code |

The hook entry point already loaded one adapter by id.

## Change

- `packages/cli/src/adapter-catalog.mjs` names each adapter id with a loader that
  imports its package only when asked. The hook, the indicator, `help`, `status`, the
  router and session discovery use it. Install, doctor and maintenance serve every
  client and keep `ALL_ADAPTERS`; a test holds both lists to the same ids.
- `main.mjs` imports a command's module when the command runs, and the store, core and
  workspace discovery when a command uses a workspace. A sent message's text, with its
  installer and SDK imports, loads with the first message a command sends.
- The router takes `loadAdapter` and loads a recipient's adapter when it offers to it.
  `registerDiscoveredSessions` takes `loadAdapters` and loads the installed clients.
  `acc` builds its router on the first offer.
- Entry points import narrow subpaths instead of package indexes: the CLI's
  `adapters`, `confirm`, `main`, `git-probe`, `runtime-paths` and `workspace-discovery`,
  the installer's `live-policy`, and the store's `writer-mutex` for the native-attempt
  writer thread. Entry point files and their `main()` signatures are unchanged, so
  older and newer runtime generations still call each other the same way.

After the change, the same loader counted:

| Entry point | Modules | Client adapters |
|---|---|---|
| `acc version` | 33 | none |
| `acc help` | 33 | none |
| `acc status`, no client present | 129 | none |
| `acc-indicator --adapter claude_code --json` | 92 | Claude Code |
| `acc-hook claude_code beforeTurn` | 137 | Claude Code |

## Start times

Each entry point ran 25 times from main at `e03124fb` and from this change, in turn,
on the same machine, with an isolated data home. Medians:

| Entry point | Main | This change |
|---|---|---|
| `node -e 0` | 34 ms | 33 ms |
| `acc version` | 132 ms | 56 ms |
| `acc help` | 125 ms | 55 ms |
| indicator read | 110 ms | 74 ms |
| hook | 167 ms | 180 ms |

macOS, M5 Max, load average 27–35. The hook's minimum was 138 ms on main and 136 ms
here; its median moved within the noise of a loaded machine.

## Tests

- `tests/process/commands-load-what-they-run.test.mjs` runs `acc version`, `acc help`,
  `acc status` and an indicator read for each adapter, and fails when one loads a
  client adapter it does not serve, or when `version` or `help` loads the store, core,
  router or hook runner. With `help.mjs` importing `install-command.mjs` again, or the
  indicator finding its adapter in `ALL_ADAPTERS`, all four of its tests failed.
- The router loads only the recipient's adapter, and only when it offers. Session
  discovery loads only the installed clients.
- An indicator test drove a mocked clock right after `runIndicator()` returned. The
  adapter now loads inside the reader before it arms its deadline, so the test loads
  the adapter first and gives the reader one turn to arm it.

## A hang found on the way

The first full suite run stopped for 26 minutes in
`tests/process/native-binding-reaches-the-receiver.test.mjs`. The same file hung on main
too: four loops of repeated runs on this machine hung after 2, 10, 10 and 38 runs. Node announces a worker on the next tick,
and the test's `waitForWorkers` cleanup began before the announcement of the offer
observation writer the test's last step started. It stopped listening, removed the
store while the writer locked it, and failed with `ENOTEMPTY`. That failure skipped the
Codex daemon fixture's own cleanup, and its listening socket kept the test process
alive. `waitForWorkers` now lets queued announcements through before it stops
listening, and the test closes its daemon before it removes its directories. After the
fix the file passed 60 runs in a row. Without the `waitForWorkers` change it failed 4 of
60 and no longer hung.

## Limits

This candidate changes no record schema, store contract or delivery protocol.
