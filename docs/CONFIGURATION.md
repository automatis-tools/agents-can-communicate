# Configuration

Start without configuration. ACC identifies a workspace from its Git common directory, or
from the directory itself when Git is absent. Sessions can communicate only when they run
as the same operating-system user on the same machine and resolve that same local
workspace.

Create `acc.workspace.json` only for stable workspace identity, roots, or shared
context budget. It is optional project configuration that `acc config init` may write
at your request; runtime state remains in platform app data outside the repository. The
file never defines agents, messages, execution state, or delivery endpoints. Project map:
[README](index.md). Terms used below: [Glossary](GLOSSARY.md).

## Decide whether you need a config

- **Identity that survives a local move.** Without a config, the same non-Git project at two
  paths is two workspaces. `workspaceId` lets the same OS user move or reopen it locally.
  Matching ids never connect different machines or OS users.
- **More than one root.** A monorepo whose apps live in separate directories, or a
  workspace that spans sibling checkouts.
- **Shared context budget.** Set the ceiling for supported injected turn context once for
  the workspace.

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
    "contextBudgetBytes": 6000
  }
}
```

| Field | Meaning | Default |
|---|---|---|
| `schemaVersion` | Must be `1` | required |
| `workspaceId` | Stable identity, portable id | required |
| `displayName` | What peers see in a roster | the directory name |
| `roots` | Directories in this workspace, relative to the config | `["."]` |
| `policy.claimMode` | Validated compatibility metadata (`advisory` or `guarded`); does not select claim enforcement | `advisory` |
| `policy.contextBudgetBytes` | Ceiling on injected turn context, 1–64000 | `6000` |
| `requiredAdapters` | Validated compatibility metadata; does not affect `acc doctor` diagnostics | `[]` |
| `extensions` | Anything else, namespaced by whoever wrote it | `{}` |

`policy.claimMode` and `requiredAdapters` are stored but have no claim or doctor effect in
0.4. CLI claims default to advisory; request `--enforcement guarded` on each claim when
appropriate, subject to every live participant's certified guard. MCP claims remain
advisory. Do not use these metadata fields to configure protection or missing-client checks.

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
acc config validate    # read-only; checks acc.workspace.json in the selected directory
```

`init` and `validate` operate only on `acc.workspace.json` directly inside the selected
`--cwd` directory (the current directory when omitted). Unlike ordinary workspace discovery,
they do not walk upward. Pass `--cwd` with the directory containing the config you intend
to inspect or create. A nested `init` can create a new config that shadows an ancestor;
check the ancestor first.

`init` shows the exact file it would write and waits. In a non-interactive run — a pipe, a
CI job, an agent — there is nobody to ask, so it refuses unless you pass `--yes`. It never
overwrites an existing config: a committed identity is shared by everyone on the project,
and replacing it on a mistyped command would split one workspace into two.

`validate` only reads. If that selected directory has no config, it reports
`no acc.workspace.json in selected directory; ancestors not checked`.
The JSON result returns default config metadata for that missing local file. Ordinary
commands may still discover an ancestor config; this is not an effective-policy report.
Run validation with `--cwd` set to that ancestor directory to check its file.

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

Codex LocalDaemon delivery separately requires macOS arm64, Codex 0.152.1 or newer, a
current feature probe, and exact thread, canonical cwd, process, version and protocol
checks. Its daemon must already be running; ACC never starts or stops it. Codex reads
consent from the installation record, not a shell-shim variable. Unavailable or ineligible
sessions retain durable inbox fallback. Use `acc install --adapter codex --delivery off`
to stop new native offers; bypassing a shim does not disable that recorded opt-in.

### Codex outgoing permissions

Receiving a native message and sending from the agent's sandbox are separate operations.
On Codex 0.153.4 or newer on macOS arm64, live opt-in also configures outgoing access
for default workspace permissions. This happens even when the daemon is not yet available.
Installation, its preview, and the interactive consent question disclose this change.

ACC selects a permission profile named `acc-workspace`, extending `:workspace`. It grants
write access to the ACC state directory and allows only the local ACC channel directory
(`/tmp/acc-ch-<uid>`) and the Codex home control socket. The profile enables networking
through `features.network_proxy = true`, with no external domains allowed. The proxy and
socket grants must stay together: enabling networking without the proxy changes its scope.

An existing legacy workspace-write configuration is migrated only when its sole writable
root is ACC's state directory. Custom permission/configuration profiles, additional roots,
inline settings and uncaptured clients are preserved and reported as unverified. ACC does
not merge arbitrary security policies or verify overrides in an already running session.
For a custom policy, grant the same state and socket access through the proxy in the
client's effective workspace profile; do not combine it with legacy sandbox settings.

Restart Codex after changing permissions. Explicit delivery `off` or uninstall restores
the previous configuration only while every generated permission component is unchanged.
If any component was edited or another setting depends on it, ACC preserves the entire
bundle and reports it for review. Plugin registration can still be removed independently.

## Override local paths and identity

Nothing in `acc.workspace.json` says where state is stored, and nothing there can — that is
the job of these variables, or the platform's own locations, and ACC refuses any of them
that resolves inside a workspace.

| Variable | Purpose |
|---|---|
| `ACC_DATA_HOME` | Base directory under which ACC creates `acc/` for runtime and coordination state. Defaults: `~/Library/Application Support` on macOS; `~/.local/share` on Linux, or `XDG_DATA_HOME` |
| `ACC_CONFIG_HOME` | Parsed and validated path override; no current configuration-storage consumer |
| `ACC_CACHE_HOME` | Parsed and validated path override; no current cache-storage consumer |
| `ACC_PARTICIPANT` | Which participant a session belongs to, when the client does not say |
| `ACC_WORKSPACE_ROOT` | The project to work in, instead of discovering one from the working directory. Absolute, or it is refused |
| `ACC_SESSION` · `ACC_GENERATION` | Explicit CLI owner credentials, supplied together by the operator for this session. Hooks do not set them. A public session ID alone never resolves a generation; see [CLI ownership](CLI.md#coordinate-from-a-session) |
| `ACC_MCP_PARTICIPANT` | Who `acc-mcp` takes part as. `mcp` by default |
| `ACC_MCP_WORKSPACE` | The project `acc-mcp` joins. Without it the server takes the directory the client launched it in, which is rarely the project |
| `ACC_NO_UPDATE_CHECK=1` | Disables update networking and background scheduling; manual recovery of an already downloaded update remains available |
| `ACC_PROBE_TIMEOUT_MS` | How long to wait for a client to print its version. Three seconds by default: generous on an idle machine, and not always enough on a busy one, where a client that overruns it is reported as not installed |
| `ACC_NATIVE_DELIVERY_POLICY` | Owned shell-bootstrap consent, currently used by Claude Code. The shim sets `off`, `actionable`, or `all`; missing/invalid values mean off for that route. Codex instead reads recorded installation consent, even when this variable is absent |
| `ACC_BYPASS=1` | Bypasses owned shell activation, currently Claude Code: no bootstrap check/native flags, and shim policy is unset. It does not disable Codex recorded opt-in; use `acc install --adapter codex --delivery off` for new Codex offers |
| `ACC_BOOTSTRAP_DEBUG=1` | Lets the internal `acc-bootstrap` check write one safe diagnostic line to stderr. Off, it is silent, and it never writes to stdout |
| `CODEX_HOME` | Codex's own home, honoured when locating the Codex App Server daemon's control socket for native delivery. Codex sets it; ACC only reads it |
