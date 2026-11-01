# Unreleased: clients with a relocated configuration

| Development artifact | Value |
|---|---|
| Built from | `235fefbdd6eb7fc7ac991e3c7d67d9362deb81eb` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 633,255 bytes, 381 files |
| sha256 | `8074bcfcb353afa2a115c4e5029b633b5cd5f5b521375422497d259c48f652b3` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

On 2026-11-01, each installed client ran with a fresh `HOME` and a separate
`XDG_CONFIG_HOME` holding decoy configurations, with the network denied, on local
commands only. No client read a decoy. Each client's own variable moved its
configuration: Claude Code 2.1.316 `CLAUDE_CONFIG_DIR`, Codex 0.166.0 `CODEX_HOME`,
Gemini CLI 0.60.0 `GEMINI_CLI_HOME`, Kimi Code 2.4.1 `KIMI_CODE_HOME` and Grok 1.0.70
`GROK_HOME`. Antigravity CLI 1.4.12 moved with none of the variables tried.

ACC now resolves `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME` and `KIMI_CODE_HOME` when they
hold an absolute path (#148). A packed test installs, diagnoses and uninstalls each of
the three clients with the variable set, unset, and set to a relative path. Reverting
the resolution made the three relocated cases fail. Doctor reports `configHome` for each
client. The same test checks that uninstall leaves no empty directory in the relocated
client directory, and that doctor names an installation made under another directory;
recording created directories only inside `HOME` made the three relocated cases fail.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. It does not establish native model execution. No package
publication or production deployment was performed.
