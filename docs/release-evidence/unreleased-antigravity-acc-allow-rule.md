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
  each command exactly as written. `src/allow-rule.mjs` inspects, adds and withdraws
  `command(<wrapper>)` in `permissions.allow`, with a claim under
  `<data home>/acc/adapter-antigravity/allow-rule-*` recording the rule and the containers ACC
  created. Install reconciles the rule with the decision; uninstall withdraws it; detect
  reports `commandApproval` and `inboundDelivery`; the plan names the settings file when the
  rule is wanted.
- `installer`: the delivery decision reaches the adapter in the plan and install contexts;
  detection carries `commandApproval`.
- `cli`: `install-command-approval.mjs` asks the second default-No question; the decision
  records `allowCommands` and rejects a yes for a delivery that is off.
- Docs: configuration, CLI, getting started, troubleshooting, capabilities, how it works,
  security model, the adapter's `COMPATIBILITY.md`.

## Tests

Each new test was seen failing for its stated reason before the change that made it pass;
the tests that assert nothing is written were proven by the mutations below.

- `packages/adapter-sdk/test/skill-command.test.mjs` (4): the shell-word rule; default,
  bare and kept-quotes bakes.
- `packages/adapter-antigravity/test/skill-plugin.test.mjs`: the installed skill is bare for
  a one-word home and quoted for a home with a space, and carries the instruction.
- `packages/adapter-antigravity/test/allow-rule-install.test.mjs` (19): add with consent and
  keep the rest byte for byte; idempotent reinstall; exact uninstall; the operator's own
  rule (bare and quoted) kept; four decisions that write nothing; withdrawal on delivery off;
  a created file removed; created containers removed only when empty; the operator's empty
  containers and empty file kept; a rule removed by hand ends the claim; four unreadable
  shapes never rewritten; an unreadable uninstall keeps the claim; the claim lives in the
  data home.
- `packages/adapter-antigravity/test/allow-rule-report.test.mjs` (7): absent, present and
  ACC's, the state-root lookup `acc doctor` uses, the operator's own rule, unreadable,
  unmatchable, and the plan.
- `packages/installer/test/delivery-decision.test.mjs`, `detect.test.mjs`: the decision
  reaches plan and install, also from the record; `commandApproval` reaches the entry.
- `packages/cli/test/install-command-approval.test.mjs` (9): who is asked, when, and what is
  recorded.
- `tests/process/antigravity-allow-rule.test.mjs` (2): from the 0.8.1 record through detect,
  the question, plan, apply, reinstall and uninstall, for a yes and a no.
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
| unmatchable check off | wrapper path that needs quotes |
| unreadable check off (inspect) | four never-rewritten tests; unreadable report |
| top level, `permissions`, `permissions.allow` shape checks off, one at a time | the matching never-rewritten test |
| consent answer ignored | declined; never asked |
| live policy ignored | delivery off with a yes on record; withdrawn consent |
| quoted one-word form unrecognised | operator's own rule (install and report) |
| ownership always true | operator's own rule not called ACC's |
| uninstall keeps the rule | six uninstall tests |
| created `allow`, `permissions`, file flags ignored, one at a time | operator's empty containers and file |
| unreadable uninstall proceeds | uninstall keeps its claim |
| claim kept after a hand removal | rule removed by hand ends the claim |
| state-root lookup removed | doctor reads the data home the installer used |
| plan never names the settings file | plan test |
| detect drops the diagnostic | absent report |
| uninstall skips the withdrawal | five uninstall tests |
| install skips the rule | fifteen tests |
| install drops its needed action | five tests |
| plan or install context without the decision, one at a time | installer decision test; yes end to end |
| detection drops `commandApproval` | installer detect test; both end-to-end tests |
| explicit `--delivery` leaves it unanswered | explicit delivery test |
| asked with delivery off | declined delivery test |
| recorded answer ignored | not asked again |
| rule state not checked | nothing to ask |
| asked with nobody at the terminal | preview and noninteractive |
| a client with no report treated as asking | ten consent tests |
| incoherent yes accepted | contradicting record |
| recorded answer dropped by `decisionOf` | two consent tests; both end-to-end tests |
| answer forced to yes | a No is recorded |
| preview note dropped | preview test |
| question never asked | five consent tests; both end-to-end tests |

The first run of "live policy ignored" survived: the fixture for delivery off also carried
`allowCommands: false`, so the consent check hid the policy check. The fixture now carries a
yes with the policy off, and the mutation is caught.

## Live capture

Pending. To be run with the user on the capture machine; see the design's
**Live capture still to do**.

## Exact local artifact

Pending: measured after the live capture.
