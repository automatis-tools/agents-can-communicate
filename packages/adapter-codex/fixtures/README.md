# Codex hook fixtures

Empty on purpose.

The event names Codex 0.147.0 supports are settled — they are an enum inside the installed
binary, recorded in `../COMPATIBILITY.md`. What is *not* settled is the payload a hook
receives on stdin. Nothing in the published documentation or in the material bundled with
the client describes it, and the binary's `HookRunSummary` fields describe the result of a
hook run rather than its input.

A fixture here is a payload recorded from a real Codex session, one file per event, named
after the event: `SessionStart.json`, `PreToolUse.json`, and so on.

Until at least `SessionStart` and `SessionEnd` are captured, the adapter declares every
capability false and `doctor` reports it as uncaptured. That is the honest state: an
adapter that normalised an unrecognised shape would attach the wrong session, or a fresh
one on every hook, and would look like it was working.
