# Claude Code native delivery captures

These redacted fixtures record only what an installed client actually exposed. A
`result` of `fail` is a boundary finding, not a test failure, and does not certify native
delivery.

`claude-code-2.1.252.json` records the documented development-channel invocation on
macOS arm64. Claude Code displayed its full-screen security warning before it spawned
the configured `acc-spike` MCP child. The operator cancelled instead of bypassing the
warning, so the Unix-domain socket was never created and every runtime branch remains
explicitly `unobserved`.

The capture intentionally excludes session ids, user content, configuration, home paths,
transcripts, credentials, and raw protocol traffic.

`claude-code-2.1.258.json` records the first passing capture, on macOS arm64, produced by
`scripts/spikes/claude-channel-fixture.mjs` from the disposable Channel's observation log
plus the operator's attested busy and fallback verdicts. The ordinary `claude` command was
launched through a temporary shell bootstrap that added only the development-channel flag;
idle, busy (presented after the turn), reply (explicit `acc_reply`), duplicate, and
fallback (queued after the Channel child was terminated) were all observed. Limitations
name what the capture did not cover. `COMPATIBILITY.md` has the timeline.
