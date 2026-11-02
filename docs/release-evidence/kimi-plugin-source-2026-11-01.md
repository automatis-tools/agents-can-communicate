# Unreleased: Kimi Code plugin installs

| Development artifact | Value |
|---|---|
| Built from | `56e3592c91984b776fae335882f64c88712765f2` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 631,369 bytes, 381 files |
| sha256 | `d0d256cd6e5ac41ec8f7f8be8c00b54dfdb1fbcabc5f884c5c4cb89e7e97b95a` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 26.5.1.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

The Kimi Code adapter now registers ACC in `plugins/installed.json` with the source
value `local-path` (#409). Kimi Code 2.4.1 accepts only `local-path`, `zip-url` and
`github`. Before this change, ACC wrote `local`. The Kimi Code TUI validates every
listed plugin after a plugin operation, so `/plugins install` failed for every plugin
with "output validation failed for pluginService.listPlugins: 0.source: Invalid input".
A reinstall replaces ACC's own record, which repairs a record written by an earlier release.

On 2026-11-01, a Kimi Code 2.4.1 registry with the ACC record changed from `local` to
`local-path` let `/plugins install` complete in the TUI. A new adapter test checks a
fresh registration and the repair of a `local` record. It also checks that other
plugin records stay unchanged.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. It does not establish native model execution. No package
publication or production deployment was performed.
