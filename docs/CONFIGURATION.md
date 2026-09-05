# Configuration

Start without configuration. ACC identifies a workspace from its Git common directory, or
from the directory itself when Git is absent. Sessions can communicate only when they run
as the same operating-system user on the same machine and resolve that same local
workspace.

Create `acc.workspace.json` only for stable workspace identity, roots, or shared
claim/context policy. It is optional project configuration that `acc config init` may write
at your request; runtime state remains in platform app data outside the repository. The
file never defines agents, messages, execution state, or delivery endpoints. Project map:
[README](index.md). Terms used below: [Glossary](GLOSSARY.md).

## Decide whether you need a config

- **Identity that survives a local move.** Without a config, the same non-Git project at two
  paths is two workspaces. `workspaceId` lets the same OS user move or reopen it locally.
  Matching ids never connect different machines or OS users.
- **More than one root.** A monorepo whose apps live in separate directories, or a
  workspace that spans sibling checkouts.
- **Shared policy.** Claim mode and context budget, agreed once and committed, rather than
  each person's machine deciding.
- **Stated expectations.** `requiredAdapters` records which harnesses this project expects
  to be installed, so `acc doctor` can say what is missing rather than leaving a session
  silently uncoordinated.

### Define the file

`acc.workspace.json`, at the root of the workspace. One name, so discovery is a lookup and
not a search. It is found by walking up from the working directory, because sessions start
wherever the human happens to be — a config that only counted at the top would apply to
some sessions in a project and not others. A config reached through a symlink is refused: a
link can point anywhere, including at a file the repository does not control.

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

Roots are refused if they are absolute or escape the workspace. An absolute root is one
machine's layout committed to a shared repository, and `packages/../../elsewhere` reaches
outside the boundary the workspace is supposed to be. The check counts path segments, so an
escape spelled in the middle is caught rather than only a leading `..`.

An unrecognised key is an error, not a shrug. `clam_mode` reads like a typo to a human and
like nothing at all to a parser that ignores what it does not know, and the result is a
team whose policy quietly stopped applying. `extensions` is the one declared door for
anything ACC does not define.

### Keep runtime state out

Sessions, participants, messages, claims, receipts, intents, events, tokens, credentials.
All of it is refused, by name, with the key that caused it, for two reasons. Runtime state
belongs under the platform data directory, so a checkout can be deleted, cloned, or synced
without carrying presence and locks along. And a config lives in a repository, where anyone
who can open a pull request can edit it — a file that could declare sessions would be a way
to hand a peer state it should have had to earn.

### Change identity safely

The config carries the workspace identity, so writing one moves the project to a new
workspace. Sessions already attached stay on the old one: they keep heartbeating it, they
drop off everyone else's roster, and claims they hold stop being seen. They do not recover
by themselves either — a session attaches when its client starts and at no other point.

So `init` refuses while sessions are attached, and names them:

```text
2 session(s) are attached here and would stop seeing each other: graphics (claude_code),
physics (codex). They re-attach only when their client starts, so close them first, or
pass --force to write anyway.
```

Close them, or pass `--force` if you mean it — and restart them afterwards.

### Create or validate it

<!-- test:illustration asks a person to confirm; there is nobody to ask in a test -->
```bash
acc config init        # preview, then write after you agree
acc config validate    # read-only; reports what applies
```

`init` shows the exact file it would write and waits. In a non-interactive run — a pipe, a
CI job, an agent — there is nobody to ask, so it refuses unless you pass `--yes`. It never
overwrites an existing config: a committed identity is shared by everyone on the project,
and replacing it on a mistyped command would split one workspace into two.

`validate` only reads. A command someone runs to find out what is wrong must not change the
thing it is inspecting. With no config present it reports the defaults rather than failing,
because not having one is a valid state.

## Keep delivery consent user-owned

Live delivery may start a model turn and spend that recipient's tokens, so it is configured
through the recipient's user-owned client installation:

```bash
acc install --adapter codex --delivery off
```

The allowed values are `off`, `actionable`, and `all`; the default is `off`. This setting
does not belong in `acc.workspace.json`, where a pull request could opt someone else into
spending a turn. It also cannot create a capability. Exact-version evidence governs
ordinary hook features; Claude Code live delivery separately requires macOS arm64, version
2.1.258 or newer, and a current feature probe before installation applies the requested
policy. If those install-time checks fail, effective policy remains `off` and the installer
reports next-turn or inbox fallback. Each later session must also pass its own
generation-bound handshake. A failed session handshake clears or refuses that binding and
reports degraded reachability; it does not rewrite the installed consent.

## Override local paths and identity

Nothing in `acc.workspace.json` says where state is stored, and nothing there can — that is
the job of these variables, or the platform's own locations, and ACC refuses any of them
that resolves inside a workspace.

| Variable | Purpose |
|---|---|
| `ACC_DATA_HOME` | Where session, claim, and message state is kept, instead of the platform default (`~/Library/Application Support/acc` on macOS; `~/.local/share/acc` on Linux, or wherever `XDG_DATA_HOME` points) |
| `ACC_CONFIG_HOME` | The same override, for configuration state the platform would otherwise keep alongside `ACC_DATA_HOME` |
| `ACC_CACHE_HOME` | The same override, for cache data the platform would otherwise keep under its own cache location |
| `ACC_PARTICIPANT` | Which participant a session belongs to, when the client does not say |
| `ACC_WORKSPACE_ROOT` | The project to work in, instead of discovering one from the working directory. Absolute, or it is refused |
| `ACC_SESSION` · `ACC_GENERATION` | Which session a command acts as when it is not worked out automatically. A supplied generation proves the exact opening; with only a session id the CLI resolves the current generation and refuses ambiguity |
| `ACC_MCP_PARTICIPANT` | Who `acc-mcp` takes part as. `mcp` by default |
| `ACC_MCP_WORKSPACE` | The project `acc-mcp` joins. Without it the server takes the directory the client launched it in, which is rarely the project |
| `ACC_NO_UPDATE_CHECK=1` | Never ask npm whether a newer ACC exists. `acc update` then says it is off, which is a different answer from "nothing is newer" |
| `ACC_PROBE_TIMEOUT_MS` | How long to wait for a client to print its version. Three seconds by default: generous on an idle machine, and not always enough on a busy one, where a client that overruns it is reported as not installed |
| `ACC_NATIVE_DELIVERY_POLICY` | Set only by an ACC-owned shell shim to the consented live policy (`off`, `actionable`, or `all`) before it `exec`s the real client, so the session's hook knows a native transport was activated. Not for a person to set: an ordinary or `ACC_BYPASS=1` launch leaves it unset, and the hook treats missing or invalid values as `off` |
| `ACC_BYPASS=1` | Runs the unmodified client through an ACC shim: no launch-time check, no native flags, and the reserved policy variable is unset. The escape hatch when you want the vendor command exactly as it was |
| `ACC_BOOTSTRAP_DEBUG=1` | Lets the internal `acc-bootstrap` check write one safe diagnostic line to stderr. Off, it is silent, and it never writes to stdout |
| `CODEX_HOME` | Codex's own home, honoured when locating the Codex App Server daemon's control socket for native delivery. Codex sets it; ACC only reads it |
