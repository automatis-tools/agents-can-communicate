# Unreleased: Kimi delivery review fixes (PR #400)

| Development artifact | Value |
|---|---|
| Built from | `ef2d96bbe290d03a2867f630276155568f723ff6` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 651,237 bytes, 390 files |
| sha256 | `af172c2c0c52197f11ccd7e35bcd8686e432e92f69b48b28c207b6d3d140d3f5` |

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
version field is 2.4.1. Codex sender grants - added and dropped by Kimi's
policy, dropped by uninstalling Kimi, never granted for an absent Kimi - and the refusal of a
duplicate offer while the first is still deciding or after an unanswered submit were exercised by the package's unit and
command tests (`packages/cli/test/codex-loopback-follows-kimi.test.mjs`,
`packages/adapter-kimi/test/web-delivery.test.mjs`); no real Codex session sent to Kimi Web in
this run. No package publication or production deployment was performed.
