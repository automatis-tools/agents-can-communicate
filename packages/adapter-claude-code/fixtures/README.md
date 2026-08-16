# Claude Code hook fixtures

Captured 2026-08-16 from `claude -p` on 2.1.233 with `--plugin-dir`, which loads a plugin
for one session only, so nothing was installed into the operator's configuration.

`transcript_path`, `prompt`, and written file content are replaced. A fixture records the
shape; it must never carry a transcript.

The surviving `PreToolUse.json` is the `Bash` capture. A `Write` capture was taken first
and overwritten by the later run; both were observed being denied, and the evidence is
recorded in `../COMPATIBILITY.md`.
