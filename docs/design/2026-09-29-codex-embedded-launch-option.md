# A launch option that makes a Codex chat run without the daemon

Issue #230, a follow-up to #224. Measured on ACC 0.8.4, 2026-09-29, with Codex CLI 0.159.1 on
macOS arm64, on the maintainer's machine and in isolated Codex homes.

## What was seen

With the app-server daemon running, `codex -c model_reasoning_effort=low` and `codex --search`
each served every request `in-process`: an embedded chat, with no live delivery. Codex 0.159.1
explains why only behind its status line ("⚠ 2 warnings · f2 to view"):

```
Running without the shared background server: command-line configuration overrides (-c,
--enable, --disable, or --search) requires embedded mode.
```

The binary names the other reasons that sentence can carry: a custom configuration loader,
`--dangerously-bypass-hook-trust`, `--strict-config`, executor selection
(`CODEX_EXEC_SERVER_URL`), `--profile`, workload identity, `--oss`, `--no-daemon` and a code-mode
host fallback policy. A failed daemon connection also falls back to an embedded server.

ACC 0.8.4 recognised the chat as `client_session_embedded`, and its doctor line, its sender line
and its one chat notice all appeared. Their advice fits only a chat that started while no daemon
ran: open a new Codex chat, and start the daemon if Codex does not. A new chat started with the
same option runs embedded again, so that advice sends the user in a circle.

The notice reached the model: it is a `developer` message in the chat's rollout, right after the
user's prompt. Asked "Say hello in one short sentence.", GPT-6-Astra at low effort answered
"Hello!" and left it out. In the #224 end-to-end check a different model relayed it. A notice that
only the model reads depends on the model.

## What a hook can show the user

A hook that prints JSON with `systemMessage` and `hookSpecificOutput.additionalContext` gets both
handled, measured with the same probe hook on Codex 0.147.0, 0.155.1 and 0.159.1, for
`SessionStart` and `UserPromptSubmit`:

- The TUI shows the `systemMessage` to the user: "↳ Hook · …" on 0.155.1 and 0.159.1,
  "• UserPromptSubmit (completed) says: …" on 0.147.0.
- The model receives only `additionalContext`, as a `developer` message. The `systemMessage`
  never reaches the model, and the JSON envelope never reaches the conversation.

The hook output schemas of every Codex release from 0.144.1 to 0.159.1 accept both fields. The
older reading, that a JSON envelope would land in the conversation, was never measured; plain
text keeps working and stays the ordinary output.

## Decisions

1. **The option that forced the chat embedded is named.** The Codex adapter already reads the
   host's command line to recognise an embedded chat. It now also finds the first of these
   options there: `--no-daemon`, `-c`/`--config`, `--enable`, `--disable`, `--search`,
   `-p`/`--profile`, `--oss`, `--strict-config`, `--dangerously-bypass-hook-trust`. The reason
   stays `client_session_embedded`, so an older ACC reading the record still gives its present
   advice; the option is a closed value beside it. Options that do not appear on the command line
   (an environment variable, a configuration loader) leave the present advice in place.
2. **The advice follows the cause.** For a named option: start Codex without it; for `-c`,
   `--enable`, `--disable`, `--search` and `--profile`, put the setting in `config.toml` instead.
   Without one: the present advice.
3. **The native-attempt record carries the option.** `launchOption` joins the attempt as an
   optional closed value. Older readers copy only the fields they know, so they drop it. Doctor's
   session line and the sender's `no_live_transport` line name the option; the delivery JSON gets
   `nativeLaunchOption` beside `nativeReasonCode`.
4. **The chat notice reaches the user directly.** An activation hint may carry a `userMessage`
   beside its model line. On the turn that delivers it, the Codex adapter prints JSON: the notice
   as `systemMessage`, the turn's usual context as `additionalContext`. Every other turn keeps the
   plain-text output. Other adapters ignore the field. The notice stays once per chat.
5. **The documentation lists the options.** The Codex compatibility notes and troubleshooting
   name the options that make a chat embedded and how to keep live delivery.
