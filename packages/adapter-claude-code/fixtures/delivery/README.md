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
