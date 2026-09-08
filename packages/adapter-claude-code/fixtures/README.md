# Claude Code hook fixtures

Captured 2026-08-16 from `claude -p` on 2.1.233 with `--plugin-dir`, which loads a plugin
for one session only, so nothing was installed into the operator's configuration.

`transcript_path`, `prompt`, and written file content are replaced. A fixture records the
shape; it must never carry a transcript.

`PreToolUse.json` is the retained `Bash` capture; `PreToolUse-Edit.json` separately retains
the edit capture used for before-write certification. During earlier collection, a `Write`
capture was taken first and overwritten by a later run; that is collection history, not
the current fixture inventory. The observations are recorded in `../COMPATIBILITY.md`.
