# Legacy Codex wrapper migration

Observed 2026-09-08T05:01:49.389Z with Codex 0.152.1 on darwin-arm64. Legacy package SHA-256: `96f0ddb5d884148046de137b3d19d71c2fe3e6d5da018d734e8044fa31121e3a`; candidate: `0de0a5e723b1939441e9e2ea2bf258e4553c139c8c18d1ce2fb3eb91b18e1a08`. Both CLIs and all inspected bytes came from npm prefixes.

| Assertion | Result |
| --- | --- |
| unmodified wrapper retired | pass |
| modified wrapper and cleanup authority preserved | pass |
| shared Claude shim and PATH block preserved | pass |
| unrelated TOML and marketplace configuration preserved | pass |
| pre-existing daemon retained through migration | pass |
| repeat install idempotent | pass |

Cleanup: passed; 16 behavioral assertions.
