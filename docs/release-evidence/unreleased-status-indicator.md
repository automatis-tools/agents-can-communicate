# ACC status indicator development evidence

Recorded 2026-10-09; updated 2026-10-10 on macOS arm64. This is development work for #284, not a release.

| Artifact | Observation |
|---|---|
| Source commit | `51b9b8aec13a7ef8b7826b70f1966023f866070b` |
| Source state before packing | Clean worktree; all feature and gate files committed |
| Package | `agents-can-communicate-0.10.4.tgz` |
| Size | 600,332 bytes |
| Entries | 368 |
| SHA-256 | `0262ed0252c1574fbcbb485428d1d45f14a1bf7f7f0ce57848bfe47da836912d` |
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
  payload through the stable reader with writes forbidden, rendered the packed
  adapter footer, and disabled it again.
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

The first extension-wide suite found extra footer paths in plans with the indicator
off; both adapters now plan those paths only when supported/enabled or when removing
a recorded indicator. The Grok selected-home packed checks pass again. A parallel
packed Kimi test also reached the intentional short UI deadline under test-runner
load. Classification in that packed test now uses the normal JSON diagnostic budget;
actual UI timing is verified separately by the native 300 ms capture above.


## Review corrections — 2026-10-11

The earlier capture and artifact records above retain their original provenance.
This follow-up changes process cleanup and diagnostic ordering, not the rendered UI.

| Artifact | Observation |
|---|---|
| Source commit | `319ccb7fb2e814bda1696061fad03e784df4b0d5` |
| Source state before packing | Clean; both fixes, tests and published documentation committed |
| Package | `agents-can-communicate-0.10.4.tgz` |
| Size | 601,811 bytes |
| Entries | 370 |
| SHA-256 | `2cd9db312ce231d6246984cdb4a25a0297703bd04504c3d8ce042e7c39eace48` |
| Node used for verification | 24.4.0 |

The saved archive passed `node scripts/verify-package.mjs`, including clean install,
non-Git operation, and exact uninstall restoration. Syntax checks covered 777 modules.
All 28 focused indicator checks passed, including 11 new regressions.

- A real previous-footer grandchild kept an IPC connection open after the old
  timeout implementation returned. The corrected timeout, cancellation, output
  overflow and outer-deadline paths close that connection. The outer deadline emits
  only one diagnostic. A shell-only kill mutation failed these assertions.
- Real observation workers published a newer result before an older result at the
  same millisecond. Both success-after-failure and failure-after-success retain the
  newer caller order. Tests also cover duplicate publication, ordinary date ordering,
  order comparison across Node processes, caller-supplied order rejection, and legacy
  records without an order. Removing the equal-time comparison failed the regressions.
- POSIX commands own a process group. Windows uses detached shell and cleanup
  processes, so the indicator's own exit cannot terminate cleanup before it finishes.
  Windows scripts that leave background processes after their shell exits must manage
  those processes themselves; cleanup does not guess ownership from an exited PID.
- The existing browser preview was run against the updated production reader and
  real filesystem fixtures. No new native UI or message-delivery capability is claimed.

The initial parallel focused run overlapped filesystem-heavy preview startup and
hit the existing deadline in `kimi: existing custom command receives identical stdin
and stays on the first line` once. All 28 checks passed sequentially;
no display budget was increased. The full repository gate uses its normal local
fsync policy and supported file-concurrency setting.

The complete local suite passed after these corrections: 3,295 tests, 3,287 passed,
8 skipped, 0 failures, at the supported file concurrency of four. Native Windows
execution of the new process cleanup cases still requires the PR CI run after push.


## Windows shell follow-up — 2026-10-11

The preceding review candidate passed Linux and macOS CI. Its Windows job failed
four tests: previous footer output in Kimi, Grok and Antigravity, and output-limit
cleanup. This follow-up supersedes its Windows subprocess implementation.

A minimal Windows probe isolated the cause. A normal shell read stdin and returned
its output, while a detached `cmd.exe` stalled. Direct detached Node execution
worked. Changing pipe mode did not help; explicit shell redirection reported an
invalid handle for stdin. The correction uses a detached Node launcher that starts
a normal hidden shell with inherited stdin/stdout. The launcher is the owned root
for `taskkill /T /F`. A startup message starts the previous-command budget; launcher
startup also has a limit. The enclosing indicator deadline is unchanged.

Two new regressions verify exact stdin through a shell command and a shell pipeline.
Both failed against the detached-shell implementation in
[Windows run 38165624465](https://github.com/automatis-tools/agents-can-communicate/actions/runs/38165624465).
The corrected implementation passed all 20 focused tests in
[Windows run 38165787567](https://github.com/automatis-tools/agents-can-communicate/actions/runs/38165787567),
including Kimi's existing composition test and all four descendant-cleanup cases.
This run used measurement commit `ddb6eb09`; the source commit below retains the
same implementation with clarified comments and published documentation. The same
20 tests passed locally. No existing assertions or display deadlines were relaxed.

| Artifact | Observation |
|---|---|
| Source commit | `dacde24fd96c1811b2300bce9ae21f06f50f360b` |
| Source state before packing | Clean; Windows fix, regression tests and documentation committed |
| Package | `agents-can-communicate-0.10.4.tgz` |
| Size | 602,217 bytes |
| Entries | 371 |
| SHA-256 | `00b172294cb5ca762919c35887e2a7fe1b5aef6a7cc41cede4565d1154a0a078` |
| Node used for verification | 24.4.0 |

The exact archive passed clean installation, non-Git operation and uninstall
restoration checks. The first full local run executed 3,297 tests: 3,288 passed,
8 were skipped, and only the recorded-candidate gate failed because it ran before
the candidate table was updated. All three candidate checks passed after the
update. The mandatory pre-push suite runs after this evidence commit.


## Timing-test follow-up — 2026-10-11

Full CI on `88e87364` passed on Linux. macOS exposed a race in the outer-deadline
test: its parent-side input delay could expire during module loading, causing the
previous-command timeout to run first. Windows passed the new process and stream
regressions, but the Kimi composition fixture exceeded the display deadline while
starting another Node process under full-suite load.

These corrections change tests only; the artifact above remains current. The
outer-deadline driver now advances its clock after importing the production reader,
then waits for a real descendant before triggering the outer deadline. A 900 ms
import delay failed the old test and passed the corrected test. Removing the
production outer cancellation made the corrected test fail because the real
descendant's IPC connection stayed open. Production code was restored afterward.

The composition fixture now uses a fast system stdin copier and asserts the entire
original payload in the composed line. Separate tests retain real Node command and
shell-pipeline coverage. No product timeout changed. All 20 focused tests passed
locally and on both platforms with file concurrency three in
[run 38167473317](https://github.com/automatis-tools/agents-can-communicate/actions/runs/38167473317).
