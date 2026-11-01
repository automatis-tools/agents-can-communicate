# Unreleased: ChatGPT Work Mode guidance

| Development artifact | Value |
|---|---|
| Built from | `c8da801915fc80154854ccc239f7677cedd77206` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 631,478 bytes, 381 files |
| sha256 | `593b7dc0f160d7dc4011d244f2c6e706e41153a2dce6238786cd2097656877c7` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

The packed change is documentation only (#316): `docs/TROUBLESHOOTING.md` names a
terminal session as the supported path when a desktop host such as ChatGPT Work Mode
denies writes to ACC's data home and allows no escalation. The capture behind it is
recorded in the Codex adapter's `COMPATIBILITY.md`, which npm does not pack.

On 2026-11-01, ChatGPT.app 26.1027.51404 in Work Mode, approval mode "Approve for me",
ran `acc-cli.sh status --json` against installed ACC 0.12.2. It exited 4 with
`state_access_denied`: the `fchmod` of the runtime directory was refused (`EPERM`), and
the runtime was ready with no update pending. A request to run the command outside the
sandbox was rejected without a prompt; the app's approval policy reported
`sandbox_approval: false` and `rules: false`.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. It does not establish native model execution. No package
publication or production deployment was performed.
