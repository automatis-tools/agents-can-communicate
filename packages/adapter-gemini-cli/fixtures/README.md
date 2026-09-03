# Gemini CLI hook fixtures

The shipped set is the `-0.57.0` files, captured 2026-09-03 from `gemini -p` on 0.57.0 -
the version this client installs as. They all come from one session, so the payload shapes
and the behaviour around them belong to the same run rather than to a collection of them.

The unsuffixed files are the 0.37.0 capture. They are kept as history and are deliberately
**not** in the package's `files` allowlist: a recorded observation is never edited in
place, and the matrix admits one exact certified version, so superseding a tier means a new
capture beside the old one rather than a rewrite of it. Their records stay in
`certification-provenance.json` with their original digests.

The 0.57.0 capture needed one thing the earlier ones did not: folder trust off. An
untrusted folder does not fail - it downgrades the approval mode, and the downgraded
toolset contains no write or shell tool, so a guard simply never fires and nothing says
why. The 0.37.0 notes below still describe how the guard payloads are reached at all.

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
