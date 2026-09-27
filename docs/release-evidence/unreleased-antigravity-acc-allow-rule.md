# Unreleased ACC commands without an approval prompt in Antigravity CLI

Implements [the 2026-09-27 design](../design/2026-09-27-antigravity-acc-allow-rule.md) for
#214. Draft: the live capture and the candidate artifact below are pending.

## What was measured before the change

ACC 0.8.1, Antigravity CLI 1.2.12 (`agy`), macOS arm64, 2026-09-27.

- The relay pushed a question into an idle session at 05:30:23 UTC. The model started a turn
  and its first ACC command, `"<home>/.gemini/config/acc/acc-cli.sh" status ...`, stopped at an
  approval prompt. The receipt stayed `offered`.
- "Yes, and always allow ... (Persist to settings.json)" logged a grant for one complete
  command, session arguments included, and wrote nothing to
  `~/.gemini/antigravity-cli/settings.json`. The next ACC command asked again five seconds
  later.
- With `command("<wrapper>")`, `command("<wrapper>" status)` and `command(<wrapper> reply)`
  loaded, `<wrapper> help` ran without a prompt, and `"<wrapper>" help` and every quoted
  `status`, `reply` and `inbox` asked. The operator's `command(sh "<relay>" start)` matched
  `sh "<relay>" start`.
- The settings are read once per start (`CLI settings initialized` once in the log). The
  file also holds `colorScheme` and `trustedWorkspaces`.

## What changed

- `adapter-sdk/hook-shim.mjs`: `isShellWord` (absolute; letters, digits, `.`, `_`, `-`, `/`)
  and `bakeSkillCommand({ bareWhenSafe })`, which bakes such a path bare and quotes any
  other. Default unchanged.
- `adapter-antigravity`: the skill is baked bare when the path allows it and says to start
  each command exactly as written. `src/allow-rule.mjs` inspects, ensures and withdraws
  `command(<wrapper>)` in `permissions.allow`, with a claim under
  `<data home>/acc/adapter-antigravity/allow-rule-*` recording the rule and the containers ACC
  created. Every install ensures the rule, whatever the delivery policy; uninstall withdraws
  it and always ends the claim. Detection reports `commandApproval` and `inboundDelivery`,
  and adds a remediation step where ACC's wrapper is on disk and its rule is missing or the
  file cannot be read. The plan names the settings file whenever a rule can be written.
- `installer`: detection carries `commandApproval`.
- `cli`: unchanged in behaviour. A record that carries `allowCommands`, written by the first
  version of this change, is read as its decision with the field ignored.
- Docs: configuration, CLI, getting started, troubleshooting, capabilities, how it works,
  security model, the adapter's `COMPATIBILITY.md`, and the design note, which records the
  user's decision of 2026-09-27 to drop the consent question and keep the rule always on.

## Tests

Each new or changed test was seen failing for its stated reason before the change that made it
pass, except the rewritten end-to-end test, which was written after the behaviour and proven by
mutation.

- `packages/adapter-sdk/test/skill-command.test.mjs` (4): the shell-word rule; default,
  bare and kept-quotes bakes.
- `packages/adapter-antigravity/test/skill-plugin.test.mjs`: the installed skill is bare for
  a one-word home and quoted for a home with a space, and carries the instruction.
- `packages/adapter-antigravity/test/allow-rule-install.test.mjs` (19): install adds the rule
  and keeps the rest byte for byte; idempotent reinstall; exact uninstall; the operator's own
  rule (bare and quoted) kept; the rule written for four install contexts (no policy, off, on,
  a record carrying the old No); a rule removed by hand put back by the next install and still
  ACC's; a created file removed; created containers removed only when empty; the operator's
  empty containers and empty file kept; uninstall ends the claim when the rule was already
  gone; four unreadable shapes never rewritten; an unreadable uninstall keeps the claim; the
  claim lives in the data home.
- `packages/adapter-antigravity/test/allow-rule-report.test.mjs` (8): absent with the
  reinstall remedy; the remediation step whatever the delivery; present and ACC's; the
  state-root lookup `acc doctor` uses; the operator's own rule; unreadable; unmatchable; the
  plan.
- `packages/installer/test/detect.test.mjs`: `commandApproval` reaches the entry.
- `packages/cli/test/install-no-approval-question.test.mjs` (5): the 0.8.1 record is asked
  nothing more; a fresh install asks only the delivery question; an explicit delivery records
  no answer about the rule; a preview says nothing about it; a record carrying `allowCommands`
  is read with the field ignored.
- `tests/process/antigravity-allow-rule.test.mjs` (2): over the 0.8.1 record through
  detection, decision, plan, apply, reinstall and uninstall, asking nothing; and delivery off
  with nobody at the terminal, which still gets the rule.
- `tests/process/skill-command.test.mjs`: the Antigravity skill's bare command is found and
  runs.

## Mutations

Each was applied alone, the named tests run, and the file restored.

| Mutation | Caught by |
|---|---|
| shell word allows a space | shell-word rule; kept-quotes bake |
| shell word allows a relative path | shell-word rule |
| bake bare by default | default bake quotes |
| bake bare without the shell-word check | kept-quotes bake; skill bare for one-word home |
| Antigravity skill baked quoted | skill bare for one-word home |
| skill instruction removed | skill bare for one-word home |
| rule gated on the delivery policy | 17 install and report tests, including the off and no-policy contexts; delivery-off end-to-end test |
| rule gated on an old recorded No | the old-No context |
| install skips the rule | 19 install and report tests; both end-to-end tests |
| plan names the settings file for a quoted wrapper, or never | plan test; the first end-to-end test when never |
| remedy asks for `--delivery` | absent report |
| claim kept when uninstall finds the rule gone | uninstall ends the claim |
| install leaves a hand-removed rule out while a claim exists | next install puts it back |
| remediation without ACC's wrapper on disk, or none for missing, or none for unreadable | the remediation test, each time |
| unmatchable check off | wrapper path that needs quotes |
| unreadable check off (inspect) | four never-rewritten tests; unreadable report |
| top level, `permissions`, `permissions.allow` shape checks off, one at a time | the matching never-rewritten test |
| quoted one-word form unrecognised | operator's own rule (install and report) |
| ownership always true | operator's own rule not called ACC's |
| uninstall keeps the rule | six uninstall tests |
| created `allow`, `permissions`, file flags ignored, one at a time | operator's empty containers and file |
| unreadable uninstall proceeds | uninstall keeps its claim |
| state-root lookup removed | doctor reads the data home the installer used |
| detection drops `commandApproval` | installer detect test; the first end-to-end test |
| `decisionOf` carries `allowCommands`, or rejects a malformed one | record carrying the old answer |

## Live capture

Pending. To be run with the user on the capture machine; see the design's
**Live capture still to do**.

## Exact local artifact

Pending: measured after the live capture.
