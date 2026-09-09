# Unreleased: actionable hook workspace warnings

This development candidate includes the [reinstall preference fix](unreleased-reinstall.md).
It retains package version 0.4.0 and must not replace the published archive; a future
publication needs a new version and the normal release gates.

| Measurement | Value |
|---|---|
| Source commit A | `edcb4dc34a7a3f23e8ef500d433f9bbef78ac00f` |
| Archive | `agents-can-communicate-0.4.0.tgz` |
| SHA-256 | `852444badb4efd9ac5c6cc24cf479374be16ac1565333edf545f081f852bedc0` |
| Size / files | 331,423 bytes / 248 files |
| Platform / test runtime | macOS arm64 / Node 24.4.0 |
| Clean-source pack / exact-archive verifier | passed |

A real Gemini CLI 0.59.0 launch from the user's home showed a generic coordination
warning. The published ACC CLI confirmed that the home contains ACC's own runtime
state and therefore cannot be a workspace. The containment rule remains unchanged.
The hook now selects static recovery advice from a closed reason code; arbitrary
filesystem and payload errors keep the generic warning.

The new packed-executable regression failed before the change. It exercises home
refusal without workspace state creation, unclassified filesystem error privacy,
and successful project registration, owner context and closure. Four exact source
mutations failed their intended assertions: lost reason, leaked error details,
disabled containment and skipped closure. Sources were byte-restored afterward.
Focused checks passed 48/48; a separate runner/regression check passed 39/39, with
overlapping coverage. Syntax checking covered 462 modules. Independent review found
no blocking issues and independently passed the packed regression's four tests.
The full suite runs after this evidence commit, per [Releasing](../RELEASING.md).

The exact archive was installed offline into a temporary prefix. Native Gemini
0.59.0 loaded a per-invocation system settings fixture that disabled the released
ACC extension and registered the installed candidate's SessionStart hook. Its
workspace intentionally contained the temporary ACC data directory. The hook
returned exit 0 with empty stdout, emitted the actionable warning without the raw
workspace path, and the native client displayed that warning on stderr and finished
naturally with exit 0. This verifies native warning presentation; it is not an
installation or certification of the candidate into the user's normal profile.

Separately, the user's normal Gemini 0.59.0 profile with **published** ACC 0.4.0
completed a project smoke: its own native identity recorded a note and a complete
handoff, then exited naturally. Final live sessions, stale sessions and claims were
zero. This is ordinary participation evidence, not new guard, next-turn delivery
or idle-wake certification. No capability flags or compatibility fixtures changed.
Raw client transcripts were not retained. The unrelated Grok owner-identity failure
from the earlier personal-install audit remains queued for a separate fix.
