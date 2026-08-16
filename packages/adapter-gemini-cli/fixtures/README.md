# Gemini CLI hook fixtures

Captured 2026-08-16 from `gemini -p` on 0.37.0. The capture hooks lived in a temporary
project's `.gemini/settings.json`, so nothing global was changed.

`transcript_path` and `prompt` are replaced. A fixture records the shape; it must never
carry a transcript.

`BeforeTool`, `AfterTool` and `AfterAgent` were missing for a long time, because the
account received HTTP 403 from the model API and no turn ever ran. They are here now: the
client was pointed at a local endpoint with `GOOGLE_GEMINI_BASE_URL`, which served one
canned turn. Only the model was stubbed - the client really called `write_file` and
`run_shell_command`, so these payloads are its own.

`BeforeTool.json` and `AfterTool.json` are the write path; the `-shell` pair is the shell
path. A guard that has only ever been seen on one kind of call is not evidence that it
covers both.

`file_path` is kept as a neutral placeholder rather than redacted: it is a resource
identifier and now flows through normalisation as `targets`, which is what a claim is
checked against. The file's contents and the command text are redacted, and the assertion
that the word `redacted` never appears in a normalised event is what proves it.
