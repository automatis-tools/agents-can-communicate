# Codex native delivery captures

These redacted fixtures record only what an installed client actually exposed. A
`result` of `fail` is a boundary finding, not a test failure, and does not certify native
delivery.

`codex-cli-0.152.0.json` was captured on macOS arm64. The generated experimental schema
contains `turn/start` with `clientUserMessageId`, `turnTrigger`, and standalone
`toolOutput`. The installed daemon control socket was absent, so the bounded spike did
not launch `codex app-server proxy`, start a daemon, resume a thread, or attempt a turn.
Every runtime branch is therefore explicitly `unobserved`.

The capture intentionally excludes thread ids, user content, socket paths, home paths,
transcripts, credentials, and raw protocol traffic.
