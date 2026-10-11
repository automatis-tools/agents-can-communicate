# Kimi and Grok indicators implementation plan

> For agentic workers: use superpowers:executing-plans. The approved brief is the user request to add Kimi then Grok while retaining useful footer content and the approved glyph styling. No further design approval is needed.

Goal: expose the current session's ACC reception in Kimi Code and Grok status lines.
Architecture: adapter-owned payload parsing and footer formatting; a shared reversible TOML command installer; the existing read-only indicator selects exact native identity. No runtime state in repositories.
Tech stack: Node 24 ESM, node:test, built-ins only.

## Constraints and review focus

- Glyph-only RGB 44,122,57 for ready. Preserve normal turn/inbox modes and existing failure diagnostics.
- Preserve an existing custom command with original stdin. Otherwise retain available native footer facts from the client's snapshot. Never infer a session from cwd.
- Kimi's command deadline is 300 ms: bound local work, no network, no transport probes; fail open to the native footer if the budget cannot be met.
- Preserve TOML bytes outside owned keys, later user edits, multiline strings, comments, custom ordering, and reinstall/uninstall behavior. Refuse ambiguous config before writing.
- Minimum versions and exact session fields require native evidence. Unsupported clients keep existing settings.

## Task 1: client contracts
- [ ] Capture Kimi and Grok command payloads from isolated native clients; record supported version, session identity, ANSI and deadline observations.
- [ ] Record any reduced scope if a required native field is unavailable; do not fake green status.

## Task 2: command composition and configuration
Files: adapter-sdk/src/{toml-indicator,indicator-text}.mjs; adapters kimi/grok src/{indicator,indicator-install}.mjs; cli/src/indicator-command.mjs.
- [ ] Add failing ownership tests for exact restoration, user overrides, repeated install, malformed and quoted/multiline TOML.
- [ ] Implement configureTomlIndicator({file,marker,table,enabled,command,defaults}) with owned-key restoration and a saved previous command.
- [ ] Add adapter statusIndicator.nativeSessionId(payload), renderText(report,{payload,previous,settings}) and adapter-specific time budgets. Plain --json/--details remain unformatted.
- [ ] Test actual piped command output, exact session routing, old command stdin preservation, timeout and input escaping. Prove new gates by reverting the guarded behavior.
- [ ] Integrate adapter install/plan/uninstall, preserving existing disabled-by-default preference.

## Task 3: shipping checks
- [ ] Execute installed npm artifact, capture native rendering, and show local browser preview.
- [ ] Run syntax, focused tests, full suite and exact package verification. Review the change independently.
- [ ] Commit source, pack exact candidate, update unpublished evidence; preserve release provenance.
- [ ] Refresh authorized local preview where clients are installed; retain rollback and update existing draft PR #288 (or a new draft if closed). Never merge.

## Progress
- Native contracts captured: Kimi2.1.1 `sessionId` equals hook identity; Grok1.0.46 `session_id` equals CLI identity.
- 87 focused checks and four packed indicator checks passed. Identity and ownership mutations failed as intended.
- Independent review found four issues, all reproduced RED then fixed GREEN: alias identity fallback, stale user item settings, nested TOML scalar conflict, and config-write retry ownership.
- Kimi limitation: native snapshot lacks goal/task/effort/rich-Git fields. Preserve available fields and native context, disclose the missing first-line details; no inference from transcripts.
- Browser preview now includes both composed rows. Grok native formatter and previous-command composition passed.
- Base: 937e7ebe. Existing feature worktree is clean. Grok contract investigation delegated read-only; implementation remains inline.
