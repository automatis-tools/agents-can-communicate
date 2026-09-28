# Codex sandboxes and the Claude Code inbox

Issue #213. Measured on ACC 0.8.1, 2026-09-27, with Codex CLI 0.157.1 and Claude Code
2.1.283 on macOS arm64.

## What was seen

A Codex session answered a question from a Claude Code session with `acc reply`. The result
said "live offer blocked by sender permissions; message remains queued": the Claude Code
adapter's connect to the session's inbox socket returned EPERM inside the Codex sandbox, which
ACC records as `transport_permission_denied`. The reply reached Claude Code only at its next
turn, through the next-turn hook. `acc doctor` meanwhile said "Codex CLI outgoing live
delivery: local socket permissions configured for new sessions".

The ACC-owned profile on that machine allowed two sockets:

```toml
[permissions.acc-workspace.network.unix_sockets]
"/tmp/acc-ch-501" = "allow"
"/Users/<user>/.codex/app-server-control/app-server-control.sock" = "allow"
```

`/tmp/acc-ch-<uid>` was the Claude Channel's directory in 0.7.x and is the Antigravity relay's
now. 0.8.0 moved Claude Code live delivery to the inbox socket Claude Code binds itself, in
`/tmp/cc-socks`. Its design never mentions a sandboxed sender, and the Codex profile and
doctor's comparison kept the old list.

## Decisions

1. **The Claude Code inbox directories are allowed** (Mykola's decision, recorded in the
   task). ACC checks Claude Code's session registry before every wake, so a directory grant
   cannot wake a reused pid.

2. **Each receiving adapter declares its sockets; the Codex adapter names no other vendor's
   paths.** Adapters may define `inboundSockets(context)`, validated by `defineAdapter` as a
   function: Claude Code its inbox directories, Antigravity the ACC channel directory, Codex
   its control socket. `installer/receiver-sockets.mjs` composes every known adapter's
   declaration, and the CLI's `clientContext` puts the list in the context as
   `receiverSockets`. Install, doctor and the managed refresh all build their context there.
   The list comes from all adapters, not the ones an install names, so
   `acc install --adapter codex` also covers a Claude Code session installed before or after
   it. The runtime platform is passed through, not the host's, so a Windows context declares
   no inbox directory. `tests/package-boundaries.test.mjs` forbids only core and protocol from
   importing adapters, but no adapter imports another today, and this contract keeps it so.

3. **Claude Code's directories**, read from the 2.1.283 executable: the session binds
   `${XDG_RUNTIME_DIR || CLAUDE_CODE_TMPDIR || "/tmp"}/cc-socks/<pid>.sock`, and
   `/tmp/cc-socks-<uid>/<pid>.sock` (`$PREFIX/tmp` under Termux) when that path is longer
   than 103 bytes. ACC declares the environment's primary directory, `/tmp/cc-socks`, the
   `-<uid>` fallback, and `/run/user/<uid>/cc-socks` on Linux. The last is Claude Code's own
   Linux default, and a session started from another environment than the installer's binds
   there. An empty variable falls through, as in Claude Code. A relative one resolves against
   Claude Code's working directory, which the installer cannot know, so it is left out. Native
   Windows serves a named pipe and declares nothing.

4. **Grants are spelled as the kernel resolves their parent.** See "What was measured". A
   `/tmp/...` grant matches only if that path exists when Codex builds the sandbox policy,
   and the `/tmp/cc-socks-<uid>` fallback usually does not. ACC resolves the deepest existing
   parent with `realpath` and appends the rest, so on macOS every entry reads `/private/tmp/...`.
   The last component keeps its spelling. The Codex control socket is a link to
   `/private/tmp/codex-daemon-<uid>/<hex>`, and that target changes with every daemon.
   Resolution is Codex-sandbox knowledge and lives in the Codex adapter. The receiving
   adapters declare paths as their clients spell them.

5. **Doctor reports configured only while every receiver is allowed.** The profile's
   `unix_sockets` must allow each resolved path. An ACC-owned profile that lacks some reads
   `sender_permissions_unverified`, and its diagnostic names the missing paths and
   `run acc install --adapter codex, then start a new session`. The consent question and
   install preview now say the allowlist covers "ACC's own channel, the Codex control socket
   and other clients' session inboxes".

6. **Upgrade.** A 0.8.0/0.8.1 profile is still ACC's own unit: its ownership hashes match, so
   it reads `owned`, not `customized`. A re-install restores the pre-ACC bytes and writes the
   new unit, so uninstall still restores the original file. The managed refresh behind
   `acc update` re-runs install with each adapter's recorded policy, so existing users get the
   new grants on update. Under a recorded `off` policy, an owned but outdated unit is also
   rewritten. The user approved ACC's local sockets, and without this the command doctor names
   could never repair the unit. It is not rewritten when the user edited ACC's unit
   (`customized`), or when a policy the user added beside it makes `hasCustomPolicy` true. A
   fresh `off` install still adds nothing.

## What was measured

With `codex sandbox -P <profile>` (Codex 0.157.1, macOS arm64) and a temporary `CODEX_HOME`
holding ACC's profile shape, never in `/tmp/cc-socks`:

- A `/tmp/d` or `/private/tmp/d` grant allows connecting through either spelling when `d`
  exists at policy build. Without a grant, the connect is EPERM.
- A `/tmp/d` grant for a directory created during the run is EPERM through both spellings. A
  second run, after `d` exists, is allowed. A `/private/tmp/d` grant is allowed in both
  cases. The same holds for a grant naming the socket file itself.
- A grant naming a link to a socket is allowed while the target exists at policy build, and
  EPERM when the target appears later.
- With this change, `acc install --adapter codex --delivery actionable` in temporary homes
  (with a version shim, so no service was prepared) wrote grants for
  `/private/tmp/acc-ch-501`, the control socket, `/private/tmp/cc-socks`,
  `/private/tmp/cc-socks-501` and the resolved `$CLAUDE_CODE_TMPDIR/cc-socks`. Doctor printed
  "configured". The real `codex sandbox -P acc-workspace` connected to a listener in
  `$CLAUDE_CODE_TMPDIR/cc-socks`, also when that directory was created after the policy was
  built. A profile with 0.8.1's two grants got EPERM for the same connect.

## Live capture, 2026-09-28

With a local build of this change and real clients, a new Codex TUI session woke a Claude Code
session that had been idle for 18 minutes: its `acc message` printed `woke … via
claude-inbox`, and Claude Code answered. The same session's message to an Antigravity relay
was offered live. The build's doctor named the three missing grants on the restored 0.8.1
profile. Details: `docs/release-evidence/unreleased-codex-sandbox-claude-inbox.md`.

## What remains unverified

- Whether a Codex TUI session builds its sandbox policy once or per command. The resolved
  spelling makes either work for the directories. The control-socket link still depends on a
  daemon running when the policy is built, as it did before this change.
- Linux: Codex's Linux sandbox and its handling of `unix_sockets` were not exercised, nor was
  `XDG_RUNTIME_DIR`. The Linux paths are covered by tests with an injected platform and
  resolver only.
- Termux and a relative `XDG_RUNTIME_DIR` or `CLAUDE_CODE_TMPDIR` are taken from the
  executable, not observed.

## Out of scope

- `docs/CONFIGURATION.md` still says outgoing setup runs on macOS arm64 only, while 0.8.1
  applies it on every platform. That text predates this change.
