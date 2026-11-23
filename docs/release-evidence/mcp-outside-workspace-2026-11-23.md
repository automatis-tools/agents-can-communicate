# The MCP server lists its tools outside a workspace: development evidence

This records the development candidate for #149. It is not a published release.

## What the investigation found

On 2026-11-23, `acc-mcp` from main was started with a JSON-RPC probe in three directories:

| Launch directory | `initialize` | `tools/list` | `acc_status` |
|---|---|---|---|
| a directory outside any Git repository | answered | the catalogue | answered: a non-Git directory is a workspace |
| a home directory that holds ACC's data home | none | none | none |
| `/`, with the data home below it | none | none | none |

In the last two cases the process exited with code 1 before it read its input. Its stderr held
an uncaught `AccError` with a stack trace: the directory "holds ACC's own state ... so it cannot
be a workspace". The entry point resolved and opened the workspace before it started serving.
MCP directories and hosts that start a server from the home directory and only call
`tools/list` saw a server that ended at once.

## Change

The entry point now catches a failure to resolve or open the workspace. It logs `no workspace:`
and the reason once on stderr, then serves without a workspace:

- `initialize`, `tools/list` and `resources/list` answer as in a workspace;
- a tool call returns a tool error, `<tool>: no workspace: <reason>`;
- `resources/read` returns an RPC error, `no workspace: <reason>`.

The same happens when the data home cannot be read, for example in a client sandbox.
`docs/MCP.md` describes it.

## Exact artifact

- Source: clean commit `5dcc4d70afbfa783a634faf90414721b316e35b9`.
- Archive: `agents-can-communicate-0.15.3.tgz`, 664,278 bytes, 393 files.
- SHA-256: `f9671e48cc5b015dad51c716fb4e4bff36f77afdfac9a14a7dd4a2839b86bbc0`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Tests and installed run

- A process test starts `acc-mcp` in a home directory that holds the data home. It checks
  `initialize`, a `tools/list` that includes `acc_status`, a tool error and a resource error,
  each starting with `no workspace:`, and exit code 0 with no stack trace. On the previous entry
  point it fails: `acc-mcp exited with 1 before answering initialize`.
- The archive was installed and its `acc-mcp` was started in such a home directory. It answered
  `initialize` and `tools/list`. `acc_status` returned `isError` with "no workspace: <home> holds
  ACC's own state at <home>/acc-data/acc, so it cannot be a workspace. Run acc inside a project,
  or point ACC_DATA_HOME outside this directory."

## Limits

- No MCP directory was run against the candidate.
