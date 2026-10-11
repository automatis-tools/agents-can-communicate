# ACC status indicator development evidence

Recorded 2026-10-09; updated 2026-10-10 on macOS arm64. This is development work for #284, not a release.

| Artifact | Observation |
|---|---|
| Source commit | `43f2d7154f97d203daaa88c207972b2142f55fb7` |
| Source state before packing | Clean worktree; all feature and gate files committed |
| Package | `agents-can-communicate-0.10.4.tgz` |
| Size | 600,216 bytes |
| Entries | 368 |
| SHA-256 | `5f2c069a7f791f43c875243710bf05e9744ba5455acebe62aff5330a5178f116` |
| Node used for verification | 24.4.0 |

The archive was saved separately, then passed to `node scripts/verify-package.mjs`.
That verifier reports `revision unknown` for a supplied archive. The source commit
above was captured before packing; it is not inferred from the verifier's current HEAD.

## Checks

- `npm ci` and syntax checks passed. The final syntax run covered 768 modules.
- 87 focused tests passed for glyph-only rendering and the shared ready
  green. The Antigravity checks cover piped output and plain JSON/details, including
  a stalled-input timeout. The complete suite also covers state classification,
  read-only execution, generation checks, delivery observations, installer ownership,
  and launcher lifetime.
- Four packed feature tests passed. The first installed the npm artifact, enabled the Claude
  module, removed the initial npm copy, and executed the stable reader. It then loaded
  the installed module through its host API boundary, retained an existing footer label,
  printed one diagnostic for a stable failure, and disabled the module again.
  The second executed the installed Antigravity reader through a pipe, with writes
  and child processes forbidden, and observed color around only the healthy dot.
  The Kimi and Grok tests enabled the installed integration, passed each native
  payload through the stable reader with writes forbidden, and disabled it again.
- Clean artifact verification passed: all binaries were installed; all packed Markdown
  links resolved; no forbidden files were present; non-Git coordination worked; and
  install/uninstall restored the client-home topology, modes, links, and bytes.
- Additional extension mutations rejected the wrong Kimi session field and reclaiming
  a user-replaced TOML status command. Five earlier deliberate mutations failed the relevant assertions: treating lease expiry as
  disconnection, reclaiming a later user edit during uninstall, attempting a write
  from the public reader, dimming the status glyph, and removing the Antigravity renderer registration. The unmutated tests passed
  again after restoration.
- Review reproductions failed before their fixes: an update losing the reader executable,
  a recorded send failure staying green, and failed verification of an expired endpoint
  staying green. Their regressions now pass. Extension review also reproduced four issues before
  correction: accepting a different client's session field, stale user footer items,
  conflicting nested TOML tables, and a failed config write blocking retries.

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

## Kimi and Grok extension observations

Kimi Code 2.1.1 passed `sessionId` equal to its native SessionStart and
UserPromptSubmit identity. One canned localhost-provider turn established this
identity; no external inference ran. Its unmodified installed ACC status command
then rendered `ACC ● · turn`, model and cwd, with the native context line below.
Ten subprocess runs with the native payload took 80.94–91.92 ms under a 300 ms
timeout. A normal SDK-created UI fixture supplied ACC state because the offline
sandbox denied a process probe during native ACC registration. This is rendering
and identity evidence, not a new registration or delivery certificate.

Grok 1.0.46 passed the exact CLI session UUID as `session_id`. Idle refreshes with
`refresh_interval = 1` ran approximately once per second. The unmodified installed
ACC command rendered `ACC ● · inbox` with cwd/model/context and also composed an
existing custom command. Only the glyph received RGB `44,122,57` and bold; native
shortcuts stayed below. A normal SDK-created UI fixture supplied ACC state; no
model prompt or inference call ran. Both captures used isolated client homes and
external network denial. Windows rendering was not captured.

The browser preview now includes both composed rows, using production rendering
and filesystem fixtures. The Kimi snapshot lacks goal/task/effort and rich Git
fields, which the documentation explicitly lists as unavailable in its custom row.
