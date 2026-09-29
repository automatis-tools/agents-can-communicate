# A Codex chat that runs without the app-server daemon

Issue #224. Measured on ACC 0.8.3, 2026-09-29, with Codex CLI 0.158.0 on macOS arm64, and in
the maintainer's Codex logs from 2026-09-26 to 2026-09-28.

## What was seen

The Mac rebooted. Codex's app-server daemon runs on the `pid` backend: no launchd or systemd
unit keeps it, and Codex's own `app-server daemon bootstrap` is for SSH use. After the reboot no
daemon ran, and `acc doctor` said:

```
Codex CLI live delivery: readiness unverified: the client's local delivery service is unavailable
acc install --adapter codex  # prepare the missing supported local service
```

A Codex 0.158.0 TUI opened in that state started the daemon itself within a second and put its
thread there: its requests arrive over `rpc.transport="unix_socket"`, and `locateCodexThread`
found the thread. The feature is `daemon_auto_start`, stable and on by default since 0.157.1
(`codex features list`); 0.155.1 does not have it. So on a current Codex the advice above is
wrong: opening Codex is enough.

The failure that costs live delivery is a different one. A TUI that finds no daemon and does not
start one runs an embedded app server, and keeps it for its whole life. Codex's logs show one:
a 0.155.1 TUI started at 2026-09-26 23:50Z, before any daemon, served every request
`in-process` until it closed at 2026-09-28 21:23Z, while two daemons ran beside it. The same
happens with `daemon_auto_start = false`, with `codex --no-daemon`, and when the auto-start
fails ("local daemon connection failed; starting embedded app server").

For that chat ACC did everything right and told nobody:

- Every turn's handshake failed and was recorded as `degraded` / `handshake_failed` in the
  native-attempt file, which only `acc doctor` reads.
- The chat itself was never told. Codex has no `nativeActivationHint`; Antigravity has one.
- A sender got "codex-X has no live transport; the message waits in its inbox", with no cause
  and no remedy.

## How an embedded chat is recognised

By the process that runs the hook, not by the socket. A hook for a daemon-hosted thread runs
under the daemon (`codex app-server --listen unix:// --managed-daemon`), which is why such a
session records the daemon's pid. A hook for an embedded chat runs under the TUI itself. The
runner already resolves that `codex` process as `clientPid`.

The socket alone would mislead: it is also missing for a moment while the daemon restarts, for
example during a Codex update, and a thread can be absent from a daemon for reasons other than
running embedded. The process check is read only when the handshake has already failed, so a
working session pays nothing for it. A host that is `codex exec` is an automated run, where live
delivery and a notice make no sense; it is excluded the way Antigravity excludes print mode.

## Decisions

1. **A new reason, `client_session_embedded`.** The Codex handshake returns it when its own
   checks failed and the host process is an interactive TUI: `codex` with no subcommand, with
   `resume` or `fork`, or with a prompt. Any other subcommand (`app-server`, `exec`, `review`
   and the rest of `codex --help`) keeps the reason it had. Its command line is read with `ps`;
   a prompt word that happens to name a subcommand reads as not interactive, which only loses a
   notice. It joins the closed vocabulary, so
   the native-attempt record, doctor's per-session line and the sender see the same word. An
   older ACC that reads such a record drops it as it drops any unknown code, and reports no
   attempt; nothing throws.
2. **The chat is told once.** Codex implements `nativeActivationHint`: for a degraded binding
   whose reason is `client_session_embedded`, one line rides with the owner header, as
   Antigravity's ask does. It tells the model that peer messages reach this chat only with the
   user's next prompt, and to tell the user how to get live delivery: open a new Codex chat, with
   the service started by `codex app-server daemon start` if Codex does not start it. An
   exclusive marker per thread keeps it to one delivered notice; a line the runner does not
   deliver gives its marker back.
3. **The sender is told the cause.** When the router answers `no_live_transport`, it adds the
   recipient session's last native reason as `nativeReasonCode`, read from the same
   native-attempt record doctor reads. It is optional and additive, like `endReason` beside
   `recipient_offline`. The CLI's line becomes "codex-X has no live transport (this client
   session runs without its local delivery service); the message waits in its inbox". MCP
   callers get the field in the delivery JSON.
4. **Doctor's advice follows the client.** When the Codex service is stopped or absent, service
   inspection asks `codex features list` whether `daemon_auto_start` is on. If it is, the report
   carries `startsOnLaunch`, and doctor advises opening Codex instead of `acc install`. With the
   feature off or absent, the advice stays `acc install`. `acc install` itself is unchanged: an
   explicit install with setup consent still starts the service at once.

## Out of scope

- ACC starting the daemon on its own. Since 0.157.1 Codex does it at launch, and ACC's rule
  that delivery never starts, restarts or stops a vendor daemon stands.
- A login item or service unit for the daemon.
- A chat that is attached to a daemon which later dies. That is a different signal (the TUI
  asks to relaunch) and has not been measured.
