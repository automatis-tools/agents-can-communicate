# Unreleased: Kimi delivery review fixes (PR #400)

| Development artifact | Value |
|---|---|
| Built from | `85b7e0acc15cf9dfa0d8847d9b442c3280a5c125` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 649,094 bytes, 389 files |
| sha256 | `22f750c60085c989846354eddc81f36c9f9f951415b451ec6dfd14b4a43725ec` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0. The
supplied-archive verifier reports its source revision as unknown; the table records the clean
source commit captured before packing.

## Real Kimi Code 2.4.1, installed from the exact archive

Every case ran the real `kimi` 2.4.1 client with an isolated `HOME`, `KIMI_CODE_HOME` and ACC
data home, installed hooks from the extracted archive, and a deterministic local provider on
`127.0.0.1`. The provider is a stub: it answers a request that names an ACC message with an
`acc reply` tool call. It does not establish a Moonshot model's judgment.

| Case | Result |
|---|---|
| Kimi Web idle wake, busy queue, reply, duplicate, fallback/restart, exact binding (C01-C06) | passed; [recorded run](kimi-delivery-review-2026-11-01-web.json) |
| Token rotation with a fresh binding | woken |
| Session created in manual mode | queued, no provider request |
| Session bound in `yolo`, then switched to manual | queued, no provider request |
| Foreign session lock | queued, no provider request |
| Reclaimed (cold) session | queued |
| `kimi -p`, a question arriving mid-turn, Stop continuation | the continuation request carried ACC's notice and the message id, never the body; `acc reply` acknowledged the message |

The recorded run's file keeps the fixture name `kimi-web-2.4.0` its recorder uses; its client
version field is 2.4.1. Codex sender grants were exercised by the package's unit and command
tests (`packages/cli/test/codex-loopback-follows-kimi.test.mjs`); no real Codex session sent
to Kimi Web in this run. No package publication or production deployment was performed.
