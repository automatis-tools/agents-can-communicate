# Unreleased: a Codex chat without the app-server daemon

## What was measured

On 2026-09-29 the maintainer's Mac (macOS arm64, ACC 0.8.3, Codex CLI 0.158.0) had rebooted.
Codex's app-server daemon runs on the `pid` backend with no launchd or systemd unit, so no
daemon ran. `acc doctor` reported `the client's local delivery service is unavailable` and
advised `acc install --adapter codex`.

- With the daemon stopped by SIGTERM and its `/private/tmp/codex-daemon-501` directory removed,
  as a shutdown and boot leave them, a Codex 0.158.0 TUI started the daemon within one second.
  Its requests arrived over `rpc.transport="unix_socket"` and `locateCodexThread` found its
  thread. `codex features list` shows `daemon_auto_start` stable and on in 0.157.1 and 0.158.0;
  0.155.1 does not have it.
- The maintainer's Codex logs show a 0.155.1 TUI that started at 2026-09-26 23:50Z, before any
  daemon, and served every request `in-process` until it closed at 2026-09-28 21:23Z, while two
  daemons ran. ACC recorded its attempts as `degraded` / `handshake_failed`, visible only to
  doctor. The chat was not told, and a sender saw only "no live transport".
- `ps -o args=` for a `codex --no-daemon` TUI printed `codex --no-daemon`; for the daemon it
  printed `.../bin/codex app-server --listen unix:// --managed-daemon`.

## What changed

- `packages/adapter-codex/src/embedded-host.mjs`, `native-delivery.mjs`: when the handshake
  fails, the adapter reads the host process. An interactive TUI (no subcommand, `resume`,
  `fork` or a prompt) gives the new reason `client_session_embedded`. A successful handshake
  never reads it.
- `native-delivery.mjs`, `adapter.mjs`: Codex implements `nativeActivationHint`. An embedded chat
  receives one line beside the owner header; an exclusive marker per thread keeps it to one
  delivered notice, and a line the runner does not deliver returns its marker.
- `packages/adapter-sdk/src/native-vocabulary.mjs`: the reason joins the closed vocabulary.
- `packages/delivery-router/src/router.mjs`, `native-reason.mjs`: a `no_live_transport` answer
  carries `nativeReasonCode` from the recipient session's last native attempt.
- `packages/cli/src/main.mjs`, `native-session-diagnostics.mjs`,
  `packages/installer/src/delivery-diagnostics.mjs`: the sender's line and doctor's session line
  name the cause.
- `packages/adapter-codex/src/service-setup.mjs`, `packages/cli/src/native-delivery-status.mjs`:
  for an absent or stopped service, inspection asks `codex features list`; with
  `daemon_auto_start` on, doctor advises opening Codex instead of `acc install`.

## Tests

- `packages/adapter-codex/test/native-delivery.test.mjs`: an interactive TUI host names the chat
  as embedded; a daemon, `exec`, `e`, `review` and an unreadable host keep the handshake's own
  reason; a successful handshake never reads the host. The first failed on the unchanged code
  with `protocol_mismatch`.
- `packages/adapter-codex/test/embedded-notice.test.mjs`: one delivered notice per chat, offered
  again after a release, none for any other state.
- `packages/delivery-router/test/router.test.mjs`, `native-reason.test.mjs`: the reason rides on
  `no_live_transport`, and an unreadable or unknown reason leaves the answer unchanged.
- `packages/cli/test/delivery-routing.test.mjs`, `native-session-deliverability.test.mjs`: the
  sender's line, doctor's session line, and the remediation with and without auto-start.
- `packages/adapter-codex/test/service-setup.test.mjs`: `startsOnLaunch` for an absent and a
  stopped service when the feature is on; none when it is off, missing or unreadable, and an
  explicit install still starts the service.

## Real processes

With the worktree's `bindNativeSession` against the running daemon (pid 12317): a real
`codex --no-daemon` TUI (pid 65254) gave `client_session_embedded`; the daemon's pid gave
`protocol_mismatch`, as before. The real `codex features list` output matched the auto-start
rule. The notice reaching a model in a real embedded chat was not captured here.

## Exact local artifact

- Source: clean commit `c9daa93237713f20f32d2cf56ef56d18172aa28a` on
  `fix/codex-embedded-notice`, from `main` at `3051920` (0.8.3).
- Archive: `agents-can-communicate-0.8.3.tgz`, packed from that commit.
- Size: 489,533 bytes; 317 packed entries.
- SHA-256: `3b1ee63b1a68b7f80f9d2fd90a25d1fc1daf23a69eedee9b1213681c0ca7fd40`.
- Package version remains `0.8.3`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
