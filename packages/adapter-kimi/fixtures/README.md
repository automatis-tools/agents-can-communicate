# Kimi Code hook fixtures

Captured 2026-08-16 from `kimi -p` on 0.36.1. The capture ran under an isolated
`KIMI_CODE_HOME`, so nothing in the user's own installation was touched.

`session_id`, `cwd`, and file paths use fixed neutral placeholders. Paths such as
`/workspace/project/notes.txt` survive normalization as resource targets. Conversation
content — prompts, tool output, error text, and written content — uses `redacted` markers
that must not survive normalization. The adapter test checks both the retained path and
the absence of those content markers.

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

## 2.4.0 delivery captures

`Stop-2.4.0.json` normalizes a real Stop payload captured on 2026-10-29. The installed
client accepted one structured continuation and delivered its reason with `system_trigger`
origin; no second continuation occurred in that turn. No conversation content is retained.

`delivery/kimi-web-2.4.0.json` is the passing native-delivery capture from an exact packed
candidate running ordinary `kimi web` with installed hooks. All six installed-product cases
passed: idle wake, busy queue, reply and acknowledgement, duplicate suppression, fallback with
restart/rebind, and exact receiver binding. The adjacent `-product-evidence.json` retains only
closed delivery facts and the candidate SHA-256, never prompts, answers, transcripts, paths or
tokens. Additional real runs passed token rotation and refused manual mode, a foreign lock and
a reclaimed session. The remaining lock/lease-check-to-submit race is recorded in the fixture.
