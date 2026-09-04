# Troubleshooting

Start with:

```bash
acc doctor
```

It reports detected clients, exact versions, installation ownership, capability downgrade,
and the next action. Restart a client after installation because hooks load at startup.

## The second session does not appear

Run `acc status --json` in both windows and compare `workspaceId`. Common causes are an
already-running client that never loaded the hook, a generic MCP server launched without
`ACC_MCP_WORKSPACE`, or two plain directories that are not the same workspace. Codex also
requires plugin trust.

ACC does not launch a missing session. Open it normally after fixing the installation or
workspace path.

## A message stays queued

Queued means the durable message is safe; it does not mean the recipient model saw it.
Have the recipient run:

```bash
acc inbox
acc inbox --message message_x
```

Certified next-turn delivery waits for that client's next normal prompt. Grok, generic MCP,
unknown client versions, and other platforms poll inbox. A reply acknowledges the original
automatically; `acc ack` is for acknowledgement-only messages.

## I enabled live delivery but got fallback

`--delivery actionable|all` is recipient policy, not a capability switch. No current
adapter has passing native live-push certification:

- Codex 0.152.0: the existing app-server control socket was absent; ACC did not start one.
- Claude Code 2.1.252: the capture stopped at the development-channel warning before the
  ACC child process started.

The installer therefore keeps effective policy off and reports exact-certified next-turn
or inbox fallback. This is expected, not a partially working live route.

## Codex plugin is listed but inactive

Trust the plugin in Codex, then restart it. Until the client accepts that trust step, hooks
do not run. `acc doctor` reports the installed cache copy and missing activation separately.

## Gemini does not guard a write

Default and `plan` modes expose no write tool to the model. `auto_edit` exposes edit tools;
shell availability depends on approval mode. Only Gemini CLI 0.57.0 on `darwin-arm64` has
package-shipped delivery certification; other versions still use inbox.

From 0.55 onwards there is a quieter cause with the same symptom: an untrusted folder. The
client prints `Approval mode overridden to "default" because the current folder is not
trusted` and keeps going, and the default mode has no write or shell tool to guard - so the
guard never fires and the mode you passed appears to have been ignored. Trust the folder,
or start the session somewhere trusted.

## Grok shows no injected message

Grok 1.0.13 discarded UserPromptSubmit context in the real capture. Its next-turn and guard
capabilities remain false. Use `acc status` and `acc inbox`; do not wait for a banner.

## Kimi sessions remain in history

Kimi 0.36.1 emits a heartbeat but prompt-mode `SessionEnd` was not observed. An exited
session becomes offline by presence rules rather than a clean end signal. The default
status hides offline sessions; `acc status --all` intentionally retains attribution and
checkout history.

## A write was blocked

Exit code `5` names the overlapping claim and owner. Ask the owner or wait for release. If
an explicit authority has decided to replace it:

```bash
acc release --claim claim_x --authority "agreed with models" \
  --reason "handing over the file"
```

## Protection says advisory

At least one live participant cannot be stopped through a certified hook, or at least one
claim asked only for advisory enforcement. This includes generic MCP and Grok. Respect the
claim manually; `guarded` would be a false room-wide promise.

## Store version is incompatible

v0.2 rejects v0.1 state and provides no migration or automatic deletion. `acc doctor`
identifies the incompatible data path. Back it up or remove it deliberately only after
confirming no needed coordination state remains.

## Uninstall left files

ACC removes only bytes that still match its install record. Anything edited by the user is
reported and retained. Remove those leftovers manually if desired.

Runtime state is outside the repository by design. `ACC_DATA_HOME` can relocate it, but ACC
refuses a path inside any workspace root.

Next: [Getting started](GETTING_STARTED.md) · [Capabilities](CAPABILITIES.md) ·
[Configuration](CONFIGURATION.md)
