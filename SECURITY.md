# Security policy

## Reporting

Report privately via [GitHub security advisories](https://github.com/automatis-tools/agents-can-communicate/security/advisories/new).

Please do not open a public issue first.

Include: what you ran, what happened, what you expected, and the client and
version. A reproduction against a throwaway `ACC_DATA_HOME` is ideal.

## Scope

| In scope | Out of scope |
|---|---|
| Peer text escaping its quoted block | An attacker who already has write access to your data home |
| Any path escaping the managed root | A model choosing to obey persuasive peer text |
| Uninstall deleting files ACC did not write | Vulnerabilities in Codex, Claude Code, Gemini, Grok, or Kimi themselves |
| ACC writing into a repository | Denial of service by a trusted peer |
| Session impersonation across MCP | |

Reasoning behind each: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Supported versions

Pre-1.0: the latest release only.

## What we will do

Acknowledge, reproduce, and tell you whether it is in scope. If it is, the fix
ships with a test in `tests/security/` so it cannot come back quietly.
