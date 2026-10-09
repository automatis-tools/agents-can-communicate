# ACC status indicator development evidence

Recorded 2026-10-09 on macOS arm64. This is development work for #284, not a release.

| Artifact | Observation |
|---|---|
| Source commit | `f452d255b50548bdd956e6df0c6d2a3544633ece` |
| Source state before packing | Clean worktree; all feature and gate files committed |
| Package | `agents-can-communicate-0.10.4.tgz` |
| Size | 593,423 bytes |
| Entries | 359 |
| SHA-256 | `8401215772d8ce5d70d69d979934750e8e40b23159eb4fc412fb5e967d954d47` |
| Node used for verification | 24.4.0 |

The archive was saved separately, then passed to `node scripts/verify-package.mjs`.
That verifier reports `revision unknown` for a supplied archive. The source commit
above was captured before packing; it is not inferred from the verifier's current HEAD.

## Checks

- `npm ci` and syntax checks passed. The final syntax run covered 754 modules.
- Seventeen focused tests passed for state classification, read-only execution,
  generation checks, delivery observations, installer ownership, and launcher lifetime.
- The packed feature test passed. It installed the npm artifact, enabled the Claude
  module, removed the initial npm copy, and executed the stable reader. It then loaded
  the installed module through its host API boundary, retained an existing footer label,
  printed one diagnostic for a stable failure, and disabled the module again.
- Clean artifact verification passed: all binaries were installed; all packed Markdown
  links resolved; no forbidden files were present; non-Git coordination worked; and
  install/uninstall restored the client-home topology, modes, links, and bytes.
- Three deliberate mutations failed the relevant assertions: treating lease expiry as
  disconnection, reclaiming a later user edit during uninstall, and attempting a write
  from the public reader. The unmutated tests passed again after restoration.
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
The unchanged problem produced one diagnostic. The renderer uses the client's native
`SessionMode.modes` list, including its own spacing and layout.

Antigravity CLI 1.3.2 invoked the configured command and displayed `ACC ! · acc doctor`
below its project-trust screen. The client required a loopback listener; external networking
remained blocked. The temporary status-line setting was restored after the observation.

Limits: authentication, a subsequent model turn, and end-to-end native registration were
not exercised in these offline UI captures. The sandbox refused Node process probes. No new
wake, injection, guard, or native delivery capability is claimed. There is no new Windows
native UI capture; the Windows integration uses the existing validated Node-shim strategy.

The [browser preview](assets/status-indicator-preview.jpg) uses actual filesystem fixtures
and the production reader. It demonstrates the approved labels and failure explanation;
it is a local preview, not a screenshot of a native client.

Reproduce that preview from the source checkout with `node scripts/preview-indicator.mjs`.
The fixture state is outside the repository and is removed when the preview exits normally.
