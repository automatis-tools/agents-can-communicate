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

`claude-code-2.1.260.json` is the release capture: the packed artifact installed into a
real home, two ordinary `claude` sessions in one workspace, and every branch observed again
on the shipped Channel rather than the spike - including a reply that is a real ACC record
(`channel-reply-<id>`), which the spike could not show. It is passing evidence beside the
2.1.258 anchor and deliberately not a second anchor: the contract has no maximum so that a
newer client is admitted by probe and handshake, and this run is what exercised that.
