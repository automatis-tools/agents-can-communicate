# The ACC indicator

The indicator describes incoming messages for the current chat. It does not describe
other chats, confirm that a message was read, or promise when an agent will answer.

In Claude Code, only the status glyph carries color: green for `●`, warning color for
`!`, and neutral for `…`. The glyph uses the client's theme without dimming. The name
and `turn`/`inbox` qualifier keep the ordinary footer color. No background is added.

Antigravity's command emits ANSI foreground color around only the glyph, even when
stdout is a pipe. Existing installed commands need no new arguments. `--json` and
`--details` keep their plain, uncolored output.

| Display | Meaning |
|---|---|
| `ACC ●` | ACC is active. This chat has an automatic delivery binding with no newer recorded failure. A busy client can queue a request. |
| `ACC ● · turn` | ACC is active. Messages arrive on the next normal turn. |
| `ACC ● · inbox` | ACC is active. The agent reads messages through `acc inbox`. This does not imply a polling schedule. |
| `ACC …` | The Claude indicator is reading state or waiting for startup hooks, for at most five seconds. |
| `ACC ! · turn` or `ACC ! · inbox` | ACC observed a failure. The qualifier names the remaining reception path. |
| `ACC !` | The chat is not registered, or the indicator cannot read its state. |

An unsupported wake-up capability is a normal `turn` or `inbox` mode. A failure of an
expected automatic channel retains `!`; it does not silently become a normal fallback.
The current `--delivery off` setting also uses the normal fallback. Details explain that
setting. Enabling the indicator does not enable automatic delivery or change its consent.

An idle chat does not lose its indicator because its heartbeat or delivery lease is old.
The sender verifies and renews an expired lease when it next attempts delivery. The badge
uses local observations. It does not test the endpoint on each refresh. Lease validity is
available in JSON as `leaseCurrent`, separately from reception and health.

## Enable or disable

```sh
acc install --adapter claude_code --indicator on
acc install --adapter antigravity --indicator on
acc install --adapter claude_code --indicator off
```

The initial preference is off. A later install or automatic update keeps the saved choice
when `--indicator` is omitted. `--dry-run` makes no changes. Normal uninstall removes the
indicator and keeps status-line settings that the user changed.

## Client surfaces

| Client | Integration and limits |
|---|---|
| Claude Code | From 2.1.287: a plugin mod adds a native footer label. It does not change `settings.statusLine`. Use `/reload-plugins` in an open session after installing. Client policy can disable mods. |
| Antigravity CLI | A status-line command adds ACC below the built-in line. If a custom command exists, ACC passes it the original stdin and appends the badge. Existing padding and stacking choices remain. Start a new CLI session after changing settings. |
| Codex and Gemini CLI | No automatic indicator installation. Their native status lines do not expose this command surface. |
| Grok and Kimi Code | No automatic indicator installation. Their custom command replaces the native line; ACC does not take it over. |
| Other hosts | A host that provides the native session id can run `acc-indicator` as a custom widget. This does not certify that host's UI integration. |

Claude prints one diagnostic when a new problem appears. `/acc-status` shows the current
explanation and recovery step without a model request. Healthy refreshes do not print
messages. Antigravity's command surface has no equivalent notification: only a problem
adds `acc doctor` to the compact line. Run that command in the project for diagnostics.

The Antigravity wrapper runs an existing enabled command with a 700 ms limit and a 64 KiB
output limit. A disabled old command stays disabled. Disabling ACC restores only the
fields ACC changed and still owns. A user replacement command takes precedence.

## Read-only command

```sh
printf '%s' '{"session_id":"native-session-id"}' | acc-indicator --adapter claude_code
acc-indicator --adapter claude_code --native-session native-session-id --details
acc-indicator --adapter claude_code --native-session native-session-id --json
```

Antigravity supplies `conversation_id`; `session_id` is also accepted. The reader selects
the saved room for that adapter and native id. It never guesses from the current directory
or scans other sessions. Output contains no generation token, endpoint, or message body.

The reader does not acquire a runtime lease, schedule updates, create a workspace,
recover a journal, send a heartbeat, renew delivery, or contact a client socket. The
managed launcher resolves the active runtime on each call. A concurrent update can cause
one failed read; a later refresh can recover without retaining the outgoing generation.

The router publishes an optional, bounded observation after a transport accepts or rejects
a send. The indicator compares it with the latest hook handshake for the same generation.
This diagnostic contains only time, outcome, and a closed reason code. Delivery receipts
and immutable history remain authoritative. An unavailable diagnostic cannot fail a send.

An unreadable state produces a closed error and a recovery command. It never renders raw
file content. A command stops waiting after 1.5 seconds. Claude refreshes every five seconds,
with one-second checks during its bounded startup period.
