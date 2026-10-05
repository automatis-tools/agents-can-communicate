# Unreleased: Antigravity CLI starts its relay without an approval prompt

| Candidate artifact | Value |
|---|---|
| Built from | `1c1adace3c47472b5d9e6a66cd7810bdc9635073` |
| Tarball | `agents-can-communicate-0.8.5.tgz`, 533,774 bytes, 329 files |
| sha256 | `93eb2e9b4434f9ea4a58478d34554a9c51add798d51b0bf2a2e1726dd908ebb7` |

Follows [#214](unreleased-antigravity-acc-allow-rule.md), which allowed ACC's wrapper.

## What was measured before the change

ACC candidate 0.8.99 (PR #243 at `977cffc3`), Antigravity CLI 1.2.16, macOS arm64, 2026-10-04,
in a home with no rule of the operator's.

- The hook told the agent to start its relay. The agent ran
  `sh "<home>/.gemini/config/acc/acc-relay.sh" start`, and the TUI asked "Run this command?".
  Nobody answered in a session left alone, so the relay never started and a peer's message
  waited for the next turn.
- The rule install wrote, `command(<home>/.gemini/config/acc/acc-cli.sh)`, does not cover that
  command: its first word is `sh`.
- 0.8.5 behaves the same; its `allow-rule.mjs` differs from the candidate's only in line
  numbers.
- The client's own "always allow (Persist to settings.json)" saves
  `command(sh "<home>/.gemini/config/acc/acc-relay.sh" start)`, which the maintainer's real
  settings hold, and which 1.2.12 was captured matching (see #214's evidence).

## What changed

- `adapter-antigravity/src/allow-rule.mjs`: `inspectRelayRule` reports a second rule,
  `command(<relayStartCommand>)`. `ensureAllowRule` adds it beside the wrapper's at every
  install, and `withdrawAllowRule` takes it back first, then the wrapper's, so a file or
  container ACC created leaves last. Each rule has its own claim; the wrapper's keeps its name,
  so an older ACC still reads the claim it wrote. Windows adds neither rule: the relay starts
  with `node`, and a rule on `node` would allow every node command. Neither does a home whose
  wrapper path needs quotes: without the wrapper's rule the agent still asks before each ACC
  command (CI on #252: on a Windows host the POSIX form's wrapper path was not one shell word,
  and the relay rule alone made the install write a file its plan did not name).
- `adapter-antigravity/src/install.mjs`: detection reports `relayApproval`, and asks for
  `acc install --adapter antigravity` where ACC's wrapper is on disk and the rule is missing.
- `installer`: detection carries `relayApproval`.
- Docs: configuration, how it works, security model, troubleshooting, upgrading.

## Tests

Each changed test was seen failing for its stated reason before the change that made it pass.

- `tests/process/antigravity-allow-rule.test.mjs`: a fresh install adds both rules with no
  question, detection reports the relay rule as allowed and ACC's, and uninstall restores the
  file byte for byte. The 0.8.1 machine, whose operator already had the relay rule, keeps it
  through install and uninstall; Windows still changes nothing.
- `packages/adapter-antigravity/test/allow-rule-report.test.mjs`: in a home whose wrapper path
  needs quotes, neither rule is written and the relay rule reads as unmatchable.
- `packages/adapter-antigravity/test/allow-rule-install.test.mjs`: the operator's own wrapper
  rule stays theirs while ACC adds only the relay rule; a settings file ACC created holds both
  rules and is removed again at uninstall.

## End to end after the change

The candidate from this branch, packed as 0.8.99, in an isolated home with the real Antigravity
CLI 1.2.16, 2026-10-04.

- Install wrote both rules to a fresh settings file.
- The agent ran `sh "<home>/.gemini/config/acc/acc-relay.sh" start` with no approval prompt, and
  doctor reported the live transport active.
- A question pushed live into the idle session was answered through `acc reply`. The session
  showed no "Run this command?" prompt from start to exit.
- `acc uninstall --adapter antigravity` removed both rules and the container ACC created; the
  client's own `trustedWorkspaces` stayed.
- The maintainer's real client files were unchanged. Two Claude Code plugin files changed during
  the run; both were written by Claude Code's marketplace refresh, and the `acc-local` entry
  was unchanged.
