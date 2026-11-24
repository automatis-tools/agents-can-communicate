# What ACC's injected context costs in tokens: development evidence

This records the development candidate for #135. It is not a published release.

## Method

`scripts/measure/context-tokens.mjs` installs an ACC archive into an isolated client
environment: a copy of a HOME that holds only the clients' sign-ins, its own npm prefix, ACC
data home and Git project. Each client runs headless, and each number is its own usage
report.

- **Surfaces.** With ACC removed again, the same prompt runs with and without one ACC text
  appended, three times. The median difference is that text's tokens in the client's
  tokenizer. The texts come from the installed hook in five coordination states, plus the
  skill listing, the installed skill and the Claude Code inbox wake.
- **Sessions.** Real sessions run without ACC, with ACC and no peer, with two peers, and with
  three messages waiting: a question, a request and a note. Each turn's first request is
  compared with the same turn without ACC.

`scripts/measure/skill-tasks.mjs` runs four tasks with a small and a large model: reply to a
peer's question, read a note, claim a file before editing it, and hand work over. The user's
prompt names the goal and never an ACC command. The result is read from the ACC store.

Things the clients add by themselves are kept out, so that only ACC differs between runs:
- Claude Code runs get no tools and no account MCP connectors.
- Codex runs leave out the account's remote plugins and apps.
- Each client gets one warm-up run first.
- Codex runs ACC's hooks with `--dangerously-bypass-hook-trust`, because the measurement
  installed them itself.

The raw results are in [`context-tokens-2026-11-23/`](context-tokens-2026-11-23/):
`tokens.json` and `tasks.json`.

## Findings

| Text | Claude Code | Codex | Gemini CLI | Kimi Code |
|---|---|---|---|---|
| Skill listing | 60 | 35 | 36 | 35 |
| Owner header, at start and on every turn | 142 | 104 | 136 | 100 |
| Turn with two peers present | 168 | 120 | 141 | 116 |
| Turn with three messages waiting | 821 | 569 | 642 | 577 |
| Turn after them | 174 | 122 | 150 | 118 |
| The `acc` skill, when loaded | 7,606 | 5,321 | 4,929 | 4,683 |

- **Session start.** With no peer, a session's first request grew by 499 tokens on Claude
  Code and 208 on Codex. Each later turn adds one owner header.
- **Kimi and Gemini CLI preloaded the skill.** Both loaded the whole skill into every session
  at start, peers or not:
  - Kimi through the plugin's `sessionStart.skill`: the first request grew by 4,888 tokens.
  - Gemini CLI through the extension's `contextFileName`: it grew by 5,370 tokens.
  - Gemini CLI 0.60.0 also lists an extension's `skills/` directory, so the skill was there
    twice.
- **The fix.** Kimi's manifest now only lists the skill. Gemini CLI's context file is
  `ACC.md`, a 413-byte pointer to the skill. With the candidate, no-peer start grew by 195
  tokens on Kimi Code and 476 on Gemini CLI.

The rule: a session with no peer pays under 0.1% of its context window at start, and the
skill loads only when a model needs it. Kimi and Gemini CLI broke the second part and now
meet it. The owner header on every turn is the remaining recurring cost: about 1% of a
million-token window after 100 turns. It is documented and left unchanged.

## Wording evaluation

| Client | Models | Before | Candidate |
|---|---|---|---|
| Claude Code 2.1.331 | `haiku`, `opus` | 8 of 8 | 8 of 8 |
| Codex 0.171.0 | `gpt-6-luna`, `gpt-6.2-astra` | 8 of 8 | 8 of 8 |
| Kimi Code 2.5.3 | `kimi-for-coding`, `k3.1-pro` | 8 of 8 | 8 of 8 |
| Gemini CLI 0.60.0 | `gemini-3.1-flash-lite` | 4 of 4 | 4 of 4 |

The skill and reminder wording is unchanged: no task failed. In two of the before runs, a Claude
Code and a Codex claim run, the model claimed the file, edited it and released the claim. The
first task check counted those runs as failures, because it looked only for a claim still
held, and the table counts them as passed. The check now reads the `claim.acquired` event.

Kimi Code's stream repeats the hook's peer block as assistant text, port and all. The read
check therefore removes ACC's peer blocks and header lines and counts only the model's own
words. The Kimi read rows come from a rerun with that check, on the same two archives.

In print mode Claude Code needs an allow rule for ACC's CLI, because nobody is there to
approve a command. The task script gives that rule for every path the CLI is installed at.

## Exact artifact

- Measured archive: built from `24f870f0`.
- Recorded candidate: clean commit `6f8c5f42c719d0f8ebbacd4d666bb7ca5f382381`.
- `agents-can-communicate-0.15.3.tgz`, 668,095 bytes, 395 files.
- SHA-256: `ae9e1d3d1c4c870254c92b340eafd3f3a0b8fcf3543cacb8d6f058025d738016`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The candidate differs from the measured archive only in `docs/CONFIGURATION.md`. It passed
`scripts/verify-package.mjs`.

## Limits

- One machine, one day, one model per client for the token table. Another model of the same
  client can tokenize differently.
- Gemini CLI ran on `gemini-3.1-flash-lite` with a free API key. The day's quota for larger
  models was spent, so the Gemini evaluation has one tier.
- Grok and Antigravity were not measured. Grok does not take a copied sign-in in an isolated
  HOME.
- Which Gemini CLI release first loaded extension skills is not verified. On an older client,
  a model reads the skill file that `ACC.md` names.
