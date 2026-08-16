# Kimi Code hook fixtures

Captured 2026-08-16 from `kimi -p` on 0.36.1. The capture ran under an isolated
`KIMI_CODE_HOME`, so nothing in the user's own installation was touched.

`session_id` and `cwd` are replaced with fixed placeholders. Every field that carried
conversation content — `prompt`, `tool_output`, `error_message`, the written file's
`content` and `path` — is replaced with a string containing the word `redacted`. That
marker is load-bearing: the adapter test asserts the word does not appear anywhere in the
normalised event, so anything the whitelist failed to drop shows up as a failure.

Three runs were needed, because the events are mutually exclusive by nature:

1. an allowed turn, held open past a minute so `SessionHeartbeat` appears;
2. a denied turn, which produces `PostToolUseFailure` instead of `PostToolUse`;
3. a run against the real provider, which the account's exhausted quota turns into
   `StopFailure`.

Runs 1 and 2 used a local stand-in provider serving one canned turn, because that
exhausted quota meant no real turn could complete. Only the model was stubbed — the
client really wrote the file and really ran the shell command, so these payloads are the
client's own. See `../COMPATIBILITY.md`.

`PreToolUse` and `PostToolUse` are kept twice each, once for `Write` and once for `Bash`.
A guard that only ever sees one kind of call is not evidence that it covers both.

Eleven of the twenty events in this client's enum are absent. `SessionEnd` was wired in
every run and never fired. The rest need a subagent, an interrupt, a compaction or a
permission prompt that prompt mode does not produce.
