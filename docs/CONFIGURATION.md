# Configuration

ACC works with no configuration at all. A workspace is identified by its Git common
directory when there is one, and by the directory itself otherwise, and every policy has a
default. This file is what a team writes when those answers are not good enough.

## When you need one

**Identity that survives a move.** Without a config, the same project checked out at two
paths is two workspaces. Two people whose clones sit in different directories do not see
each other. `workspaceId` fixes that, and it is the usual reason this file exists.

**More than one root.** A monorepo whose apps live in separate directories, or a workspace
that spans sibling checkouts.

**Shared policy.** Claim mode and context budget, agreed once and committed, rather than
each person's machine deciding.

**Stated expectations.** `requiredAdapters` records which harnesses this project expects to
be installed, so `acc doctor` can say what is missing rather than leaving a session
silently uncoordinated.

## The file

`acc.workspace.json`, at the root of the workspace. One name, so discovery is a lookup and
not a search. It is found by walking up from the working directory, because sessions start
wherever the human happens to be - a config that only counted at the top would apply to
some sessions in a project and not others.

```json
{
  "schemaVersion": 1,
  "workspaceId": "workspace_9pQ2f1xJ",
  "displayName": "Example",
  "roots": ["."],
  "policy": {
    "claimMode": "advisory",
    "contextBudgetBytes": 6000
  },
  "requiredAdapters": []
}
```

| Field | Meaning | Default |
|---|---|---|
| `schemaVersion` | Must be `1` | required |
| `workspaceId` | Stable identity, portable id | required |
| `displayName` | What peers see in a roster | the directory name |
| `roots` | Directories in this workspace, relative to the config | `["."]` |
| `policy.claimMode` | `advisory` or `guarded` | `advisory` |
| `policy.contextBudgetBytes` | Ceiling on injected turn context, 1–64000 | `6000` |
| `requiredAdapters` | Harnesses this project expects | `[]` |
| `extensions` | Anything else, namespaced by whoever wrote it | `{}` |

## Commands

```bash
acc config init        # preview, then write after you agree
acc config validate    # read-only; reports what applies
```

`init` shows the exact file it would write and waits. In a non-interactive run - a pipe, a
CI job, an agent - there is nobody to ask, so it refuses unless you pass `--yes`. It never
overwrites an existing config: a committed identity is shared by everyone on the project,
and replacing it on a mistyped command would split one workspace into two.

`validate` only reads. A command someone runs to find out what is wrong must not change
the thing it is inspecting. With no config present it reports the defaults rather than
failing, because not having one is a valid state.

## What this file must never contain

Sessions, participants, messages, claims, receipts, intents, events, tokens, credentials.
All of it is refused, by name, with the key that caused it.

Two reasons. Runtime state belongs under the platform data directory, so a checkout can be
deleted, cloned, or synced without carrying presence and locks along. And a config lives in
a repository, where anyone who can open a pull request can edit it - a file that could
declare sessions would be a way to hand a peer state it should have had to earn.

Roots are refused if they are absolute or escape the workspace. An absolute root is one
machine's layout committed to a shared repository, and `packages/../../elsewhere` reaches
outside the boundary the workspace is supposed to be. The check counts path segments, so
an escape spelled in the middle is caught rather than only a leading `..`.

An unrecognised key is an error, not a shrug. `clam_mode` reads like a typo to a human and
like nothing at all to a parser that ignores what it does not know, and the result is a
team whose policy quietly stopped applying. `extensions` is the one declared door for
anything ACC does not define.

A config reached through a symlink is refused. A link can point anywhere, including at a
file the repository does not control.

## Relationship to runtime paths

Nothing here says where state is stored, and nothing here can. That is
`ACC_DATA_HOME`/`ACC_CONFIG_HOME`/`ACC_CACHE_HOME` or the platform's own locations, and
ACC refuses any of them that resolves inside a workspace.
