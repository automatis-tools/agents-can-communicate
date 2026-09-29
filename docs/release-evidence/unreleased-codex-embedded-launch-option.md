# Unreleased: the launch option that keeps a Codex chat embedded

Issue #230. Design: `docs/design/2026-09-29-codex-embedded-launch-option.md`.

## What was measured

On 2026-09-29, during the local check of ACC 0.8.4 on the maintainer's machine (macOS arm64,
Codex CLI 0.159.1, the daemon running), `codex -c model_reasoning_effort=low` and
`codex --search` each served every request `in-process`, while a plain `codex` used the daemon.
Codex's warning, shown only behind `f2 to view`: "Running without the shared background server:
command-line configuration overrides (-c, --enable, --disable, or --search) requires embedded
mode." ACC 0.8.4 recognised the chat as `client_session_embedded`, but advised opening a new chat
or starting the daemon, which does not help. The notice reached the model as a `developer`
message; GPT-6-Astra at low effort answered "Hello!" to "Say hello in one short sentence." and did
not pass it on.

A probe hook answering JSON with `systemMessage` and `hookSpecificOutput.additionalContext` for
`SessionStart` and `UserPromptSubmit`, in isolated Codex homes on 0.147.0, 0.155.1 and 0.159.1:
the TUI showed the `systemMessage` to the user, and the model received only `additionalContext`,
as a `developer` message. The envelope never reached the conversation. The hook output schemas of
every installed release from 0.144.1 to 0.159.1 accept both fields.

## What changed

- `packages/adapter-codex/src/embedded-host.mjs`: `embeddingOption` finds the first option on an
  interactive command line that keeps the chat embedded (`--no-daemon`, `-c`/`--config`,
  `--enable`, `--disable`, `--search`, `-p`/`--profile`, `--oss`, `--strict-config`,
  `--dangerously-bypass-hook-trust`), stopping at the prompt; `embeddedHost` returns it.
- `packages/adapter-codex/src/native-delivery.mjs`: the `client_session_embedded` refusal carries
  it as `launchOption`; the chat's one notice names it, advises starting Codex without it (moving
  a setting into `config.toml`), and comes with a `userMessage`.
- `packages/adapter-codex/src/hooks.mjs`: a turn with a `userMessage` prints JSON, the message as
  `systemMessage` and the context as `additionalContext`; every other turn stays plain text.
- `packages/adapter-sdk`: a refused handshake may carry an optional `launchOption`, a bare option
  token; the native-attempt record keeps it; `isLaunchOption` is exported.
- `packages/hook-runner`: the binding outcome and the recorded attempt carry the option; an
  activation hint may add a bounded `userMessage`, handed to the adapter's `injectOutcome` on the
  turn that carries the hint.
- `packages/delivery-router`: the recipient's last native reason includes the option, and a
  `no_live_transport` result adds `nativeLaunchOption`.
- `packages/cli`, `packages/installer`: doctor's session line and the sender's line name the
  option and advise a new session without it.
- `packages/adapter-codex/COMPATIBILITY.md`, `docs/TROUBLESHOOTING.md`,
  `docs/ADAPTER_AUTHORING.md`: the options, the measurement and the new handshake field.

## Tests

Each test of a new behavior failed before its change; the checks that pin an absence (no option
named, a dropped message) passed before and after:

- `packages/adapter-codex/test/embedded-host.test.mjs`: every option in every spelling is named,
  the first one wins, and values, prompt words and non-interactive runs name none.
- `packages/adapter-codex/test/native-delivery.test.mjs`: an embedded chat's refusal names the
  option, and names none without one.
- `packages/adapter-codex/test/embedded-notice.test.mjs`: the notice and the user's message name
  the option and the right advice; an unusable option falls back; a turn with a user message
  prints `systemMessage` JSON.
- `packages/adapter-sdk/test/native-delivery.test.mjs`: only a refused handshake may name an
  option, and only a bare option token.
- `packages/delivery-router/test/native-reason.test.mjs`, `router.test.mjs`: the option reaches
  the sender's result, and an invalid one is dropped with the reason kept.
- `packages/hook-runner/test/native-activation-hint.test.mjs`: the option reaches the hint and
  the recorded attempt; the user's message reaches `injectOutcome`, and one that is not a single
  bounded line is dropped with the ask kept.
- `packages/cli/test/delivery-routing.test.mjs`, `native-session-deliverability.test.mjs`: the
  sender's line and doctor's line name the option.

## Real client

The candidate below was installed from its archive into an isolated prefix with its own `HOME`,
`CODEX_HOME` and `ACC_DATA_HOME`; `acc install --adapter codex --delivery actionable` started the
self-installed daemon of Codex 0.159.1. After "Trust all and continue", `codex --search` got
"Say hello in one short sentence." at 22:00:25Z. The TUI showed:

```
↳ Hook · ACC: live peer delivery is off in this chat: `--search` makes Codex run it on its own
app server. For live delivery, start Codex without `--search` and move what it sets into
config.toml.
```

The rollout held the model's line as a `developer` message and neither `systemMessage` nor the
envelope. A note from an attached participant printed `codex-gD3imk has no live transport (the
client was started with --search, which runs this session on its own embedded service that peers
cannot reach); the message waits in its inbox`, and doctor's session line ended `start a new
client session without --search`. The next prompt showed no notice. Every process started from
the isolated directories was stopped and the directories deleted.

## Suite

`npm test` on `e0c5f0b`, under `env -i` with only `HOME`, `USER`, `TMPDIR` and a PATH of system
directories plus node, as in CI: 2,793 tests, 2,792 passing, 0 failing, 1 skipped (the existing
uninstall check that skips on a machine where Gemini CLI is installed), in 9.4 minutes.
