# Handoff acceptance validation — 2026-09-12

This is an unreleased development record, not new native-client certification.
Published v0.5.2 evidence remains unchanged. The package version is still 0.5.2;
this archive was not published or installed into the user's active clients.

## Source and installed artifact

- Base: `08905f3` (v0.5.2).
- Receipt/reply contract: `5af466b`.
- Complete packed source: `1c383bd100e884d7b1100de1dd2c6bd6f41f6027`.
- Source tree was clean immediately before `npm pack`.
- Archive: `agents-can-communicate-0.5.2.tgz`, 386,345 bytes, 272 files.
- SHA-256: `0e08924e9fbe0043f5a32cd146f619b4f03c146167f9b0c539fe98b031874921`.
- Capture: Darwin arm64, Node v26.5.1, npm 11.17.0.

`ACC_NO_UPDATE_CHECK=1 node scripts/verify-package.mjs <exact-archive>` passed:
clean installation; all three binaries; five adapters in doctor; a non-Git
workspace with no project writes; install/uninstall restoration and idempotency;
272 permitted entries; packed documentation links; bundled workspace versions;
and the existing certification evidence allowlist. The verifier correctly reports
revision unknown for a supplied archive; the clean-tree pack above supplies its
source provenance. No existing capability claim was changed.

## Contract tests and mutations

Before implementation, the new ten core tests and first two installed CLI tests
ran against old behavior: 12 tests, 1 pass, 11 failures. The failures exposed both
silent acknowledgement of unanswered requests and the acknowledged-reply ban.

Each mutation below was applied to the production source, executed, and restored
before the passing runs. CLI/MCP tests pack and install the mutated source into
isolated temporary fixtures; they do not substitute a mocked executable.

| Mutation | Executed tests | Observed result |
|---|---:|---|
| Remove unresolved reply-obligation check in `ack` | 10 core + 3 installed CLI/MCP | 8 failures: six receipt-state cases plus CLI and MCP |
| Restore the acknowledged-reply ban | 10 core + 3 installed CLI/MCP | 5 failures: three handoff statuses plus CLI and MCP |
| Remove the already-acknowledged exemption from the new check | 10 core | 1 failure: idempotent acknowledgement after a reply |

Passing focused checks on the final source:

- Syntax: 520 tracked `.mjs` files.
- Core, receipt router, installed handoff CLI/MCP, MCP-only, and actionable-turn
  checks: 193 tests, 193 passes, no skips.
- Documented addresses and skill contracts: 9 tests, 9 passes.
- Skill frontmatter validation: all five adapter skills passed.
- `git diff --check`: passed.
- Independent review and final-text follow-up: no blocking findings.

The clean baseline full suite had 2,124 tests, 2,123 passes, zero failures, one
skip. The first post-change full run had 2,137 tests and three failures: an old
MCP fixture that acknowledged a question, an invalid example recipient alias,
and stale artifact provenance. The fixture and alias were corrected and rerun;
the new Unreleased artifact record resolves provenance without rewriting history.

## Synthetic skill exercise

The cases are retained in [skill-scenarios.md](skill-scenarios.md). These are
synthetic prompts, not collected session transcripts. Fresh isolated subagents
used `gpt-5.6-sol` with high reasoning, no parent conversation, no ACC calls,
no edits, and no network. Each returned proposed actions and user-facing text.
No proposed read, claim, reply, or implementation is counted as executed work.

The baseline exercised cases A–C in five samples with the original Codex skill
at `08905f3`, SHA-256
`36700b9d112b1af17707b782a843b6ed90c454137b67a3daa151359bd3e53150`.
Five final samples exercised A–D with the complete final Codex skill, SHA-256
`ddfff773cec05cd6153a70edeebf9c0064ee96059117bd21272770eab93acad3`.
Every final sample confirmed reading both files through EOF (305 and 50 lines).

| Observed proposed behavior | Baseline | Final |
|---|---:|---:|
| A: ask user for the specific missing continuation scope | 0/5 | 5/5 |
| B: accept only the authorized local lint work and name an orientation step | 5/5 | 5/5 |
| C: use addressed `finish` with honest `complete` status and excluded backlog | 0/5 | 5/5 |
| D: preserve context without accepting work or asking for a new task | not run | 5/5 |

All baseline sender samples kept the original goal complete, but none proposed
the single addressed `finish` operation: alternatives included separate notes,
room handoffs, and unsupported `message --type handoff` commands. Baseline
receivers generally oriented or confirmed context without asking the missing
scope question. Final context-only samples used four bare acknowledgements and
one substantive receipt-only reply, neither accepting new work.

Intermediate wording probes exposed a regression to receipt-only stopping and
led to the explicit two-outcome incoming-work recipe. Some later development
probes read only the first 260 skill lines, omitting its Finish section; those
are excluded from the final full-skill results. The final harness required EOF,
not a fixed line range, and all five final samples verified it.

Limits: these small samples show proposed behavior, not a statistical guarantee,
executed continuation, or validation of every generated command argument. Some
responses restated peer completion claims without explicit attribution or put
acceptance before orientation; the exercise does not prove independent factual
verification. Other adapter skills passed parity/structural checks, not separate
native-model acceptance runs. No new real-client wake, delivery, attention, or
execution capability is claimed. `acknowledged` still means receipt, not accepted
scope or completed work, and `finish` still closes the sender's ACC presence.
