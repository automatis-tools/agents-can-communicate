# Task 9 report — canonical bootstrap prompt and operator documentation

## Scope

Added the committed canonical prompt, operator guide, literal renderer, and public `prompt` CLI command. The renderer validates the shared agent-id schema and rejects NUL-bearing input before replacing only the four template tokens; all prompt prose remains in `docs/AGENT_COMMS_PROMPT.md`.

`AGENTS.md` now requires the scoped local-parallel bootstrap without changing the established track or worktree rules. `.agents/` is explicitly ignored with the required project-local-state comment. No CI configuration or runtime bus state was added.

## TDD evidence

RED: `node --test tests/tools/agent_comms/prompt.test.mjs` exited 1 with `ERR_MODULE_NOT_FOUND` for `tools/agents/lib/prompt.mjs`. After the renderer test was green, the command black-box case was run with `prompt` deliberately absent and failed with exit 2 (`unknown command: prompt`).

GREEN: focused prompt plus integration tests passed 5/5. The complete protocol suite passed 178/178.

## Acceptance coverage

- Rendering is byte-for-byte the committed template after literal replacement; only `<AGENT_ID>`, `<ROLE>`, `<TASK>`, and `<OWNERSHIP>` appear as template tokens.
- Tests cover all eight checkpoint polls, failed register/watcher stop-work rule, peer confirmation before shared-contract edits, reply versus ack for action/blocker messages, evidence-bearing blocked handoff and close, and the host reasoning-turn limitation.
- A real subprocess proves `prompt` stdout equals `renderPrompt()` exactly and stderr is empty. Unsafe ID and NUL input are rejected.
- `docs/AGENT_COMMS.md` covers discovery, lifecycle, all v1 commands, states, status, claims, handoffs, exits, plaintext safety, stale/recovery behavior, host limits, and deferred CI rollout.

## Verification

```text
node --check tools/agents/comms.mjs
node --check tools/agents/lib/prompt.mjs
node --check tools/agents/lib/args.mjs
# all exit 0
node --test tests/tools/agent_comms/prompt.test.mjs tests/tools/agent_comms/integration.test.mjs
# 5 passed, 0 failed
node --test tests/tools/agent_comms/*.test.mjs
# 178 passed, 0 failed
git diff --check
# clean
wc -l changed code/test files
# comms 292; prompt 24; args 95; prompt test 92
```

## Ignore-context limitation

The linked-worktree rule itself is verified by `git check-ignore -v .agents/protocol.json`, which identifies `.gitignore:.agents/`. The exact plan command for the shared bus path, `git check-ignore -v ../../.agents/protocol.json`, is rejected by Git 2.50 because that path is outside the linked worktree. The unmodified main checkout is clean and has no branch-local `.gitignore` change, so it cannot prove the new rule until this branch is integrated; it was not modified. This is a Git worktree boundary in the prescribed verification, not a protocol defect.

## Self-review

Checked that prompt dispatch does not initialize or mutate runtime state, that renderer values cannot inject NUL bytes, that repeated ownership becomes valid repeated `--ownership` arguments, and that the prompt documents explicit watcher shutdown before `close`. No deviations from Task 9.

## Round 1 — accepted review findings

RED: parser and subprocess tests first showed that `prompt` accepted both no
`--ownership` and an empty ownership argument; the subprocess returned exit 0.

GREEN: the parser now requires at least one non-empty ownership argument and
returns stable usage exit 2 before rendering. Focused parser/prompt/integration
tests passed 12/12; the complete protocol suite passed 180/180.

The operator guide now gives executable `--requires-ack` forms for `send`,
`broadcast`, and `reply`, plus the full `handoff` required argument grammar,
structured evidence-file shapes, and commit versus `--uncommitted` rule. The
canonical prompt now says to claim the exact scope before **any** edit. Ignore
verification is correctly documented as feature-worktree-local before merge and
main-checkout-local after merge; the invalid outside-worktree path is no longer
presented as a required proof.

## Round 2 — accepted review finding

RED: mixed blank-plus-valid ownership values and whitespace-only ownership were
accepted by the parser, and the subprocess rendered a prompt with exit 0.

GREEN: `prompt` now requires an ownership array with one or more entries and
rejects every blank or whitespace-only repeated value with usage exit 2 before
rendering. Accepted values are not trimmed or otherwise changed. Focused tests
passed 13/13; full protocol verification is recorded below after this round.
