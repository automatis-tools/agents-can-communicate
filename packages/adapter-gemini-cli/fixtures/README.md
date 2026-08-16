# Gemini CLI hook fixtures

Captured 2026-08-16 from `gemini -p` on 0.37.0. The capture hooks lived in a temporary
project's `.gemini/settings.json`, so nothing global was changed.

`transcript_path` and `prompt` are replaced. A fixture records the shape; it must never
carry a transcript.

Only four events are here. `BeforeTool`, `AfterTool`, and `AfterAgent` never fired because
the account received HTTP 403 from the model API, so no turn ran. Until they are captured,
the adapter declares no guard and no injection - see `../COMPATIBILITY.md`.
