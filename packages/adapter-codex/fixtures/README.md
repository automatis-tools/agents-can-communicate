# Codex hook fixtures

Captured 2026-08-16 from a real `codex exec` session on codex-cli 0.147.0, run against an
isolated `CODEX_HOME` so nothing in the operator's own configuration was touched.

Each file is the exact payload the named hook received on stdin, with three fields
replaced: `transcript_path`, `prompt`, and `last_assistant_message`. A fixture records the
*shape*, which is what was unknown; it must never carry a transcript.

## Why these exist

The event names were already settled from an enum in the binary. The payload shape was
not documented anywhere, so until this capture the adapter declared every capability false
and refused to normalise a shape it had never seen.

## What the capture changed

- Codex's file-editing tool is `apply_patch`, not `Write` or `Edit`. The hook matcher
  originally copied from Claude Code's vocabulary would never have fired on a file edit,
  so the adapter would have reported edits as guarded while letting every one through.
- Hook commands must be absolute paths. A relative `./scripts/x.sh`, which is what the
  installed example plugins use, failed on every event.
- Every payload carries `transcript_path`, `UserPromptSubmit` carries the raw `prompt`,
  and `Stop` carries `last_assistant_message`. Codex hands conversation content to hooks
  directly, so whitelist normalisation is what keeps it out of coordination state.
