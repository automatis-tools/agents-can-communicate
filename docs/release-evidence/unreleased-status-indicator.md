# ACC status indicator development evidence

Recorded 2026-10-09; updated 2026-10-10 on macOS arm64. This is development work for #284, not a release.

| Artifact | Observation |
|---|---|
| Source commit | `2d5bd55b025f937a60ba172dc73f1fcf0fd3d2c5` |
| Source state before packing | Clean worktree; all feature and gate files committed |
| Package | `agents-can-communicate-0.10.4.tgz` |
| Size | 594,326 bytes |
| Entries | 360 |
| SHA-256 | `f2a9f11ca154e8b55066de873129376a69eddacd2be17de7d487a95323185ec7` |
| Node used for verification | 24.4.0 |

The archive was saved separately, then passed to `node scripts/verify-package.mjs`.
That verifier reports `revision unknown` for a supplied archive. The source commit
above was captured before packing; it is not inferred from the verifier's current HEAD.

## Checks

- `npm ci` and syntax checks passed. The final syntax run covered 757 modules.
- Seven focused color tests passed for glyph-only rendering and the shared ready
  green. The Antigravity checks cover piped output and plain JSON/details, including
  a stalled-input timeout. The complete suite also covers state classification,
  read-only execution, generation checks, delivery observations, installer ownership,
  and launcher lifetime.
- Both packed feature tests passed. The first installed the npm artifact, enabled the Claude
  module, removed the initial npm copy, and executed the stable reader. It then loaded
  the installed module through its host API boundary, retained an existing footer label,
  printed one diagnostic for a stable failure, and disabled the module again.
  The second executed the installed Antigravity reader through a pipe, with writes
  and child processes forbidden, and observed color around only the healthy dot.
- Clean artifact verification passed: all binaries were installed; all packed Markdown
  links resolved; no forbidden files were present; non-Git coordination worked; and
  install/uninstall restored the client-home topology, modes, links, and bytes.
- Five deliberate mutations failed the relevant assertions: treating lease expiry as
  disconnection, reclaiming a later user edit during uninstall, attempting a write
  from the public reader, dimming the status glyph, and removing the Antigravity renderer registration. The unmutated tests passed
  again after restoration.
- Review reproductions failed before their fixes: an update losing the reader executable,
  a recorded send failure staying green, and failed verification of an expired endpoint
  staying green. Their regressions now pass.

The first full-suite development run found two corrupt-settings regressions, the new
binary mode/inventory omissions, and stale candidate provenance. The settings and inventory
checks were corrected. This record supplies the new candidate provenance without rewriting
older release records. The final full suite and mandatory pre-push gate run against this
record, after the exact archive check.

## Native UI observations

Claude Code 2.1.295 loaded the installed module in a native TUI with external networking
blocked. Its validator first rejected a nested helper receiving `$`; moving that helper to
module scope passed validation. The TUI showed the bounded startup label and `ACC !`, while
`user-status-preserved` remained visible. `/acc-status` printed the reason and recovery step.
The unchanged problem produced one diagnostic. The first renderer appended the native `SessionMode.modes` list. User testing
showed that this dimmed the successful dot to gray. The corrected renderer preserves
the native footer reference and colors only a separate glyph. An offline light-theme
capture emitted RGB `102,102,102` for `ACC` and RGB `44,122,57` with bold styling
for the dot. No ACC element sets a background color.

Follow-up user testing found the Claude theme color paler than Antigravity. The
ready glyph now uses Antigravity's exact RGB `44,122,57` (`#2c7a39`) instead of the
theme's `success` value. An offline Claude Code 2.1.296 TUI with the installed module
and a healthy-state fixture reader emitted that RGB and bold for `●`. The existing
render assertions failed with `success` and passed with the fixed green. The other
states retain their theme colors.

Antigravity CLI 1.3.2 invoked the configured command and displayed `ACC ! · acc doctor`
below its project-trust screen. The client required a loopback listener; external networking
remained blocked. The temporary status-line setting was restored after the observation.

With the previous Antigravity color candidate (`40bab3cd`), a second offline capture used the
unchanged installed Antigravity command and an isolated empty data home. The native
TUI emitted RGB `150,108,30` and bold only for `!`; `ACC` and the diagnostic suffix
retained the default foreground. No background was set. The test PTY had its inherited
`NO_COLOR=1` unset for this color observation. The packed-reader check separately
verified RGB `44,122,57` on a healthy dot. This fixes the user-observed black dot:
Antigravity had previously received a label with no ANSI foreground sequence.

Limits: authentication, a subsequent model turn, and end-to-end native registration were
not exercised in these offline UI captures. The sandbox refused Node process probes. No new
wake, injection, guard, or native delivery capability is claimed. There is no new Windows
native UI capture; the Windows integration uses the existing validated Node-shim strategy.

The [browser preview](assets/status-indicator-preview.jpg) uses actual filesystem fixtures
and the production reader. It demonstrates the indicator on a light background;
it is a local preview, not a screenshot of a native client.

Reproduce that preview from the source checkout with `node scripts/preview-indicator.mjs`.
The fixture state is outside the repository and is removed when the preview exits normally.
