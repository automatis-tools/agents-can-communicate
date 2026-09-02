# Grok native delivery captures

These redacted fixtures record only what an installed client's public, vendor-supported
surface exposed. A `result` of `fail` is a boundary finding, not a test failure, and does
not certify native delivery. The capture is produced by
`scripts/spikes/grok-leader-capture.mjs`, which starts no client, leader, or ACP server.

`grok-1.0.13.json` was captured on macOS arm64 from `grok --version`, `grok --help`,
`grok agent --help`, and `grok agent leader --help`. The public leader surface
(`--leader`, `--no-leader`, `--leader-socket`, `grok agent leader`, `[cli] use_leader`)
shares one backend between clients; the vendor documents `cli.use_leader` for config
reload and MCP watches. Nothing on that surface names an addressed message injection into
an independently opened ordinary TUI session, the leader socket protocol is private, and
`grok agent serve` / `grok agent stdio` change launch ownership. Every runtime branch is
therefore explicitly `unobserved`.

The capture intentionally excludes session ids, user content, configuration, home paths,
transcripts, credentials, and raw protocol traffic. It is not listed in the package
`files` allowlist because `certification.json` carries no evidence for it; a passing
capture would add both together.
