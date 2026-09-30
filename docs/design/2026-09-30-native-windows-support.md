# Native Windows support

Issue #234. Researched 2026-09-30 on ACC 0.8.5 (main `c08c86d`), on a GitHub `windows-latest`
runner (Windows build 26100, Node 24.21.0, x64) and from the sources and binaries of the six
supported clients.

## Why ACC stopped at the `os` field

In August 2026 the Windows CI job ran the suite for the first time and failed 86 of 587 tests.
Two causes were found, a directory fsync and `O_NOFOLLOW`, and Windows was removed from the
matrix with `"os": ["darwin", "linux"]` in `package.json` (commit `4c31275`). Since then ACC
added a process table read through `ps`, Unix-socket live delivery, a managed runtime with
leases, pins and automatic updates, and POSIX shell shims for every hook. The first outside user
who tried ACC runs Windows 11 and stopped at `EBADPLATFORM`.

The decision now is to support native Windows, not to document it away:

- **0.9.0** installs and runs on Windows 10 and 11 (x64 and arm64) with Node 24 or later:
  the store, the CLI, the MCP server, the managed runtime with automatic updates, hooks for all
  six clients, next-turn delivery and doctor. CI runs the whole suite and the package check on
  Windows.
- **0.9.x** adds live delivery on Windows: the Claude Code inbox pipe, the Codex daemon through
  its stdio proxy, and the Antigravity relay.
- Verification is CI only: real clients run headless on the Windows runner against a local model
  stub, and interactive clients run under a ConPTY driver. The author of #234 tests the release
  candidate.

## What Windows does differently

Measured on the runner with `scripts/tmp_windows_probe.mjs` (branch `measure/windows-suite`):

| Fact ACC relies on | Windows result |
|---|---|
| `fsync` on a directory handle | `EPERM` |
| `fs.constants.O_NOFOLLOW` | `undefined`; an open through a file symlink succeeds |
| `rename` over a file that a reader holds open | `EPERM` |
| `rename` over a file another process holds, with any `FileShare` mode | `EPERM`; a read of a file held without `FileShare.Read` is `EBUSY` |
| `rename` of a directory that has an open file inside | `EPERM`; 6 of 50 renames failed while one reader polled a file inside |
| `rename` of a directory onto an existing directory, empty or not | `EPERM`, never `EEXIST` or `ENOTEMPTY` |
| `link` onto an existing name | `EEXIST`, as on POSIX |
| `open(…, "wx")` on a dangling symlink | creates the link's target; POSIX refuses with `EEXIST` |
| `unlink` of an open file, `rm -r` of a directory with an open file | succeed |
| `rm -r` of a directory that is a live process's cwd | `EBUSY` |
| `listen()` on a filesystem path | `EACCES`; `\\.\pipe\…` names work |
| a second `listen()` on a pipe name in use | `EADDRINUSE`, so a pipe name cannot be taken over while it is served |
| `chmod(0o600)`, `chmod(0o700)` | no effect; `stat().mode & 0o777` is always `0o666` |
| `stat().uid`, `process.getuid` | `0`, `undefined` |
| profile ACLs (`%USERPROFILE%`, `%LOCALAPPDATA%`, `%TEMP%`) | SYSTEM, Administrators and the user only |
| `process.kill(pid, 0)` | works: `true` while alive, `ESRCH` after exit |
| process table | no `ps` (Git's MSYS `ps` only when Git's `usr\bin` is on PATH), no `wmic`. `Get-CimInstance Win32_Process` returns pid, ppid, creation time and command line. A full scan took 1.07 s in Windows PowerShell 5.1 and 0.37 s in `pwsh` 7, warm; the first call on the machine took 3.8 s. PowerShell 5.1 starting and running nothing took 0.2 s; one filtered query by pid took 0.32 s in total |
| `execFile` of a `.cmd` shim | `EINVAL` without a shell |
| `realpath` vs `realpath.native` | only `.native` canonicalises case and 8.3 names |
| `os.tmpdir()` | an 8.3 short path (`C:\Users\RUNNER~1\…`) |
| a 345-file `node --test` command line | over the 32K limit with absolute paths |
| file ids | `ino` and `dev` are stable across `lstat` and `fstat` |

Each client runs hooks through a different Windows shell:

| Client | Hook command runs through | Source |
|---|---|---|
| Claude Code | exec form (`command` + `args`, no shell) since 2.1.139; shell form uses Git Bash, or PowerShell without Git | Claude Code docs |
| Codex | `pwsh`/`powershell -NoProfile -Command`; a `commandWindows` field replaces `command` on Windows | `codex-rs/hooks` |
| Gemini CLI | PowerShell, exit code kept | `hookRunner.ts` |
| Grok | detected: pwsh, Git Bash or powershell; `GROK_SHELL` overrides | binary strings, bundled docs |
| Antigravity CLI | `cmd /c`; Go escapes inner quotes as `\"`, which cmd does not read | bundled hooks doc, issue #222 |
| Kimi Code | Node `spawn(…, {shell: true})`, so `cmd.exe /d /s /c` | `runHook.ts` |

## Design

### 1. Filesystem primitives

One module per runtime boundary owns the platform differences, and every caller goes through it:
`storage-filesystem` for the store and the writer lock, and a launcher-safe copy in the managed
runtime, because launcher modules may import only their siblings.

- **Directory sync.** POSIX makes a rename durable by syncing the directory, and the store relies
  on it: the active journal's publication decides a transaction, so a lost rename would lose a
  transaction the caller saw succeed. Windows refuses a flush on a directory handle, and an
  unprivileged process cannot flush the volume. On Windows ACC therefore flushes the entry the
  rename or link produced: it opens that file for writing and calls `sync`. NTFS journals the
  rename as metadata, and flushing a file on NTFS commits that journal up to the file's last
  change, which includes the rename. A power cut cannot be reproduced in CI, so this rests on
  documented NTFS behaviour, not on a measurement.
- **Replacing a file.** `rename` over an existing file retries `EPERM`, `EACCES` and `EBUSY` with a
  short backoff until the caller's deadline. The cause is measured: any open handle on the target
  refuses the rename, whether it belongs to an ACC reader, an antivirus scan or an indexer. A read
  retries `EBUSY` the same way, because a scanner that opens without read sharing refuses readers.
  POSIX keeps the single call.
- **Renaming a directory onto a name.** Windows reports an existing target as `EPERM`, not
  `EEXIST` or `ENOTEMPTY`. After `EPERM` the helper checks the target: if it exists, the error
  becomes `EEXIST`, so the writer lock, the manager lock, launchers and generations keep their
  contention logic. Otherwise the `EPERM` came from an open file inside the source, as when a
  contender reads a lock's `owner.json` during release, and the rename is retried.
- **Releasing the writer lock.** Retrying is not enough for the store's writer lock: every
  waiting writer polls its `owner.json`, and eight of them on `windows-latest` kept the
  directory from moving until one of them gave up at the acquire timeout. On Windows the owner
  moves the record out instead. A file can be renamed while other handles have it open, because
  Node opens with `FILE_SHARE_DELETE`. The lock is then an empty directory, which a waiting writer
  removes with `rmdir` before it takes the name, just as POSIX `rename` replaces an empty lock.
  `rmdir` cannot remove a lock that has an owner in it. Reclaiming a dead owner still moves
  the whole directory, because Node's rename replaces an existing file on Windows: a late
  reclaimer that moved `owner.json` could take a successor's record.
- **A name that goes away while it resolves.** Linux reports `ENOENT` when a directory is
  renamed or removed while `realpath` resolves it. Windows answers the same window in four ways
  (measured with a second process renaming or removing the directory in a loop): `ENOENT`,
  `EBADF`, `EPERM` with the name already gone, or a path in `C:\$Extend\$Deleted\`, where NTFS
  keeps a directory that was deleted while something still had it open. The store's directory
  walk reads all of them as "gone", so a read of a lock that changed hands returns nothing and
  does not report an unsafe path. `EPERM` on a name that is still there stays a refusal. Opening
  a file in a directory being removed fails `EPERM` the same way, and reads as absent once the
  name is gone.
- **A lone record without the journal.** A session's heartbeat, every turn, replaces one record
  and appends no event, and it went through the whole journal: an entry prepared, activated, the
  record published, a completion marker and the journal set idle, five atomic writes and ten
  flushes on Windows, where one flush cost 8 to 23 ms on windows-latest. One record needs no
  journal to appear at once: the rename replaces it atomically, with the bytes flushed before and
  the name after. It is published directly only while the active journal is idle. An open one,
  left by a writer that died, would later roll its own bytes over the record, and it refuses a
  journalled write as well, so that case keeps the journalled path and its refusal. Any
  transaction with an event, a removal or a second record keeps the journal.
- **A second session, and a first publication.** A second live session wrote an ephemeral copy
  of itself, which the materialising transaction then copied and retired one lock at a time. It
  now opens in that transaction, and only while the session it joins is still live under the
  lock: otherwise it is a lone session and opens ephemerally, as before. An ephemeral record's
  first publication writes no retention marker, because a record with no marker is present.
  That marker was an atomic write, three flushes on Windows, for each record a new session
  opened with. Together with the lone-record path, a turn made 24 flushes and syncs on macOS
  and now makes 8, and a second session's start went from 80 to 52.
- **Validating a store directory once.** Every record read walked its directory from the store
  root twice, `lstat` and `realpath` for each level: about a thousand calls a hook, 130 ms of one
  on windows-latest. A directory validated once is now known by its identity (volume and file
  id, read as bigint because an NTFS file id does not fit a double), and a later check of the
  same name is one `lstat`. `lstat` follows every ancestor, so an ancestor replaced by a link
  lands on another directory, and anything but the validated identity takes the whole walk
  again. The one case the walk would still refuse and the check does not is the store's own
  directory moved elsewhere with a link left at its name: the same data in another place.
  Decided with the maintainer on 2026-09-30, for every platform.
- **Creating a file exclusively.** `open(…, "wx")` follows a dangling symlink on Windows and
  creates its target. ACC creates such files only under random names inside its own private
  directories, where planting a link already requires the user's own access, so the rule holds.
  The file boundary check below runs on every read either way.
- **Removing a tree.** `rm` gets `maxRetries` on Windows. A generation that is still some process's
  cwd stays and is retried by the next reclaim pass, which already runs hourly.
- **Opening without following a link.** Without `O_NOFOLLOW`, ACC `lstat`s the path, refuses a
  symlink or junction (Node reports both as symbolic links), opens it, and compares the handle's
  `dev` and `ino` (as bigint) with the `lstat` result. A mismatch means the name was swapped
  between the two calls and is refused. This restores the rule the store, the workspace config and
  the managed runtime rely on, including the race case.
- **Private files.** POSIX creates ACC's directories `0700` and checks `(mode & 0o077) === 0`
  and the owner uid only on the endpoints and vendor files of live delivery. Windows has no such
  bits; privacy comes from the ACL every file inherits from the user profile, and
  `%LOCALAPPDATA%` grants only the user, SYSTEM and Administrators (measured with `icacls`).
  0.9.0 relies on that inheritance, the parity of what POSIX checks today. The per-file checks
  arrive with live delivery in 0.9.x: an endpoint or vendor file (Claude session keys, the Codex
  pid file) must then lie inside the vendor's home under the same profile, and its ACL is read
  once, by SID so that a localized Windows reads the same.

### 2. Paths and workspace identity

- **Data home.** Windows uses `%LOCALAPPDATA%\acc`, not the roaming `%APPDATA%`: pids, locks and
  pipe names are machine-local and must not follow a roaming profile. No Windows install exists,
  so nothing migrates. Each of the three data-home resolvers changes its Windows branch; they stay
  separate because the launcher's copy may use Node built-ins only.
- **Config roots.** `assertRoot` refuses `\x`, `\\server\share` and `D:x` on every platform. Today
  a committed `acc.workspace.json` can name a UNC root, and resolving it on Windows contacts that
  host from a hook. Refusing it everywhere keeps a repository that is safe on POSIX safe on
  Windows.
- **Canonical paths.** Identity comparisons use `realpath.native`, which canonicalises case and
  8.3 names. Git's `C:/…` output is resolved the same way before a comparison.
- **Claims.** A `file:` claim path with a backslash is converted to `/` by every entry point,
  including MCP, so a Windows claim cannot be recorded and then protect nothing.

### 3. Process identity

On Windows ACC reads `Win32_Process` through WMI, one filtered query per hop from the asking
process upward, never a full scan. Windows Script Host runs the walk: `cscript.exe` with a
JScript file that ships in the package (`windows-process-chain.wsf`). It printed the chain in
145 ms on windows-latest, against 580 ms for the same walk in PowerShell 7, and 258 ms against
1,080 ms with four hooks reading at once, because it starts no .NET runtime. Each hop carries
pid, ppid, image name, command line and WMI's creation time, which ACC turns into a FILETIME.
Non-ASCII characters are escaped in the output, so no code page can change it. A machine can
switch Script Host off by policy; the same walk then runs in PowerShell (`pwsh.exe` when
present, `powershell.exe` otherwise), within the same deadline.

- **Matching a client.** Image names are compared without `.exe` and case-insensitively, and
  `node.exe` counts as the script host that `node` is on POSIX.
- **Stale parents.** Windows does not re-parent orphans, so a ppid can name a dead or reused
  process. The walk accepts a parent only if it was created before its child.
- **Depth.** Claude Code's exec-form hooks make the client the hook's direct parent. PowerShell-
  and cmd-hosted hooks put one shell between them. The walk stops at the client or after a small
  fixed number of hops.
- **Budget.** A session start begins the read as soon as its event is known, while the store
  opens, so the walk costs no time of its own; it gets up to 3 s. A read that still times out
  fails open, as today, and the next user-turn hook binds the session. Later hooks reuse the pid
  the binding recorded.
- **Client version.** npm installs a Windows client as a `.cmd` that runs node on the package's
  script, and asking it for `--version` starts cmd.exe, node and, for Codex, the native binary:
  11.5 s on a fresh runner. ACC reads the version from the package whose `bin` is the script the
  `.cmd` runs, which is what `--version` prints, and runs the client only when the `.cmd` is no
  such shim.
- **Identity.** Where POSIX compares `ps lstart`, Windows compares the creation FILETIME. That
  covers the Codex daemon pid file and the legacy worker check.
- **Leases and pins** keep "process death is the only expiry" on both platforms. A reused pid only
  holds a generation longer, which is conservative.

### 4. Executables and child processes

- **Finding a client.** The search walks PATH with `PATHEXT` and prefers a real `.exe`. An npm
  `.cmd` shim is run through `cmd.exe /d /s /c` with arguments that ACC quotes itself, and only
  with fixed arguments such as `--version`.
- **npm for updates.** Windows uses `node_modules\npm\bin\npm-cli.js` next to `node.exe`. On
  Windows the `npm` in that directory is a shell script.
- **No console windows.** Every spawn passes `windowsHide: true`. Detached workers additionally
  pass `detached: true`, which must let them outlive the parent (to be measured, see Open
  measurements).
- **Signals.** Windows does not deliver SIGTERM to a handler. A process that must clean up on stop
  (the Antigravity relay) exposes a stop request on its own pipe, and uninstall uses that request
  before it terminates the process.

### 5. Hook, CLI and skill entry points

POSIX keeps the `sh` shims. Windows gets Node shims, `acc-hook.mjs` and `acc-cli.mjs`, with the
same resolution order: the baked node and runner first, then `acc-hook`/`acc` on PATH, then
`node` on PATH. Each shim loads the runner in-process when the node that runs it satisfies the
engine range; it starts the baked node only when it does not.

| Client | Command ACC writes on Windows |
|---|---|
| Claude Code | exec form: `{"command": "<node.exe>", "args": ["<plugin>/hooks/acc-hook.mjs", "<event>"]}` |
| Codex | `commandWindows`: `& "<node.exe>" "<shim>" <event>; exit $LASTEXITCODE` |
| Gemini CLI, Grok | `node "<shim with forward slashes>" <event>`, valid in PowerShell, Git Bash and cmd |
| Antigravity CLI | `node <shim> <event>` with no quotes; the 8.3 form of the path when it contains a space |
| Kimi Code | today's `"<node.exe>" "<runner>" kimi <kind>`, valid for cmd |

- **The skill command** becomes `node "<forward-slash path>/acc-cli.mjs"`, which works in bash,
  PowerShell and cmd, whichever shell the client uses for the model.
- **The owner header** double-quotes `--cwd` and `--workspace`, which bash, PowerShell and cmd
  read alike. A value with `$`, a backtick or `%` is expanded by one of them inside double
  quotes, and gets single quotes instead, which bash and PowerShell read literally. A value
  that also contains a single quote is refused: bash reads `'\''` inside single quotes and
  PowerShell reads `''`, so no spelling reads the same in both, and the bash one leaves the rest
  of the value bare to PowerShell, where `$(...)` runs. The hook then fails open and names the
  directory to rename. Windows file names cannot contain `"`.
- **Doctor** recognises the Node shims and Windows paths when it names the wired version.

### 6. Managed runtime and updates

Launchers are already `.mjs` files that run as `node <file>`, and the active generation is a
pointer in `control.json`, not a symlink. What changes is below the surface: the filesystem
primitives of section 1, the npm path of section 4, and hidden detached workers. Generation file
modes are part of the generation fingerprint; on Windows they are always `0o666`, so a Windows
generation name differs from the same release's POSIX name, which is correct because it is a
different installation.

### 7. Live delivery (0.9.x)

- **Claude Code.** Claude binds `\\.\pipe\cc-msg-<32 hex>` and requires an auth line on Windows.
  It publishes a per-session peer key for other sessions of the same user in
  `<config>/sessions/<pid>.<sha256(canonical pipe name)>.key` as `{peerToken, procStartFt,
  pidDomain}`. A frame authenticated with it is classified `peer`, so the recipient's inbound
  settings (`crossSessionInbound`, the bypass-mode hold) apply as they do on POSIX. ACC reads that
  key, checks that `procStartFt` equals the recipient process's creation time, sends
  `{"type":"auth","token":<peerToken>}` and then the fixed wake line. ACC never reads the child
  token `CLAUDE_CODE_MESSAGING_TOKEN`, which would skip those settings.
- **Codex.** The Windows daemon listens on a real AF_UNIX socket,
  `%CODEX_HOME%\app-server-control\app-server-control.sock`, and Node cannot connect to AF_UNIX
  on Windows. Codex ships `codex app-server proxy`, which relays stdio to that socket. ACC starts
  it per offer and speaks the same WebSocket JSON-RPC over the child's stdio. Daemon identity uses
  the pid file, the creation time and the command line; the socket directory has a user-only DACL
  that Codex sets itself, which replaces the `lsof` proof.
- **Antigravity CLI.** The relay listens on `\\.\pipe\acc-relay-<random>`. The random name is kept
  in the private registration. The agent API is localhost TCP and works unchanged.
- **Router.** Windows transports keep their names (`claude-inbox`, `codex-app-server`), so status
  and doctor name them.

### 8. Security model changes

- Windows privacy is the profile ACL, checked once for the data home, instead of mode bits on each
  file.
- On Windows ACC reads the Claude peer key; it still never reads the child token.
- `assertRoot` refuses rooted, drive-relative and UNC config roots everywhere.
- Named pipes live in a machine-wide namespace. ACC's own pipe names carry 128 random bits and
  are stored only in private records; Node's default pipe ACL gives write access to the creator
  only.

## Verification

- **CI.** `windows-latest` joins the test and package matrices. The runner passes test files in
  chunks that fit the command line. Tests that build POSIX fixtures (sh scripts, Unix sockets,
  mode bits, `SIGSTOP`) get Windows equivalents for the same behaviour. A test is skipped only
  where the behaviour itself does not exist on Windows, and the skip names that reason.
- **Real clients.** A CI job installs Claude Code, Codex and the other clients on the Windows
  runner and points them at a local model stub (`ANTHROPIC_BASE_URL`, a Codex model provider),
  so their real hooks fire through ACC: install, SessionStart, a turn, a message from another
  session delivered on the next turn, SessionEnd, uninstall.
- **Package.** `scripts/verify-package.mjs` runs on Windows: install from the tarball, doctor, a
  workspace, install and uninstall of every client.

- **Codex daemon in CI.** On the runner, `codex app-server daemon start` (0.159.2) refused:
  "start the Windows daemon from a non-elevated terminal; shared clients must not inherit
  administrator privileges". GitHub's Windows runner is elevated, so the 0.9.x Codex live check
  runs the daemon and the TUI under a non-elevated token (`runas /trustlevel:0x20000` or a
  standard local user created in the job).

## Open measurements

These change details, not the design. The implementation measures them in its own Windows CI
tests before it relies on them:

1. Whether a detached, hidden worker outlives its parent (the first probe's case was malformed).
2. What `codex app-server daemon start` writes on Windows under a non-elevated token: the pid file
   format and the socket file's `lstat` result.
3. The Claude Code and Codex command lines as `Win32_Process` reports them, launched through their
   npm `.cmd` shims and the native installers.
