# An allow rule for ACC commands in Antigravity CLI

Issue #214. Measured on ACC 0.8.1 with Antigravity CLI 1.2.12 (the `agy` binary), macOS
arm64, 2026-09-27.

## What was seen

Antigravity CLI asks for approval before each shell command. The relay pushed a question
into an idle session at 05:30:23 UTC. The model started a turn, and its first ACC command,
`"<home>/.gemini/config/acc/acc-cli.sh" status ...`, stopped at an approval prompt. Nobody
was at the terminal, so no reply was sent and the receipt stayed `offered`. Live delivery
woke the session and produced no result.

The client's own "Yes, and always allow ... (Persist to settings.json)" option does not
remove the stall. It logged a grant for one complete command line, with that session's
`--session`, `--generation`, `--cwd` and `--workspace` values, and wrote nothing to
`settings.json`. The next ACC command, five seconds later, asked again.

## What the capture established

The rules live in `~/.gemini/antigravity-cli/settings.json`, under `permissions.allow`, as
strings of the form `command(<words>)`. `~/.gemini/settings.json` is Gemini CLI's file and
has no effect here. The client reads its settings once at startup: the log line
`CLI settings initialized` appears once per start. Its changelog says a rule is matched
strictly unless it starts with `regex:`, each token of a grant is matched as a full word, and
a one-word grant such as `command(git)` is a prefix.

One session was started after these rules were written, beside the operator's existing
`command(sh "<home>/.gemini/config/acc/acc-relay.sh" start)`:

- `command("<home>/.gemini/config/acc/acc-cli.sh")`
- `command("<home>/.gemini/config/acc/acc-cli.sh" status)`
- `command(<home>/.gemini/config/acc/acc-cli.sh reply)`

| Command the model ran | Approval prompt |
|---|---|
| `"<wrapper>" status --json --session ...` | yes |
| `"<wrapper>" reply --message ... --body ... --session ...` | yes |
| `"<wrapper>" inbox --session ...` | yes |
| `<wrapper> help` | **no** |
| `"<wrapper>" help` | yes |

`<wrapper>` is `<home>/.gemini/config/acc/acc-cli.sh`. The last two rows differ only in the
quotes around the program word. The operator's own rule `command(sh "<relay>" start)`
matched `sh "<relay>" start`, where the quotes are around an argument. The conclusions:

- A one-word rule is a prefix rule. The only loaded rule that can match `<wrapper> help` is
  the quoted one-word rule, so a rule's own quotes do not stop a match.
- A command whose first word is in quotes matched no rule, quoted or unquoted. Quotes around
  an argument are fine: the relay rule matches `sh "<relay>" start`.
- The installed skill wrote every example as `"<wrapper>" <subcommand>`, so the model always
  quoted the program word, and no rule could have helped.

## Decisions

1. **The rule ACC writes is `command(<wrapper>)`**, the wrapper path bare, one word. It is a
   prefix for every command whose first word is that path. The issue's decision names this
   form. The captured match was made by the quoted one-word form `command("<wrapper>")`; the
   bare form tokenizes to the same single word for a path without shell metacharacters,
   which is the only kind of path ACC writes a rule for. The bare form's own match is part of
   the live capture below. Either form, already present, counts as the rule.
2. **The skill names the wrapper bare when the path is one shell word.** A path is one shell
   word when it is absolute and holds only the POSIX portable filename characters (letters,
   digits, `.`, `_`, `-`) and `/`. `bakeSkillCommand({ bareWhenSafe: true })` bakes such a
   path bare and quotes any other. Only the Antigravity adapter asks for it; every other
   client's skill is unchanged. The Antigravity skill also tells the model to start each
   command exactly as written, with no quotes added and no `sh -c` wrapper. Nothing else ACC
   injects names the wrapper: hook context says `acc inbox ...`, and the relay's peer message
   says to answer with the acc skill.
3. **A path that needs quotes gets no rule.** A home with a space makes the wrapper quoted in
   the skill, and a quoted first word matches nothing, so a rule would only look like a
   grant. Install writes nothing and says why; doctor says the prefix rule cannot apply and
   names the quoted-first-word behaviour.
4. **The rule is always on.** Every install of the Antigravity adapter writes it, with no
   question, whatever the delivery policy, interactive or not, a preview aside. This is the
   user's decision of 2026-09-27 (below), and it replaces a first design that asked a
   separate default-No question. Nothing is recorded about it in the installation record:
   `deliveryDecision` carries no `allowCommands`, and a record that still has one from that
   first design is read as its decision with the field ignored. The installer no longer
   hands the delivery decision to adapters, since only that question needed it.
5. **Install ensures the rule; only uninstall takes it back.** A rule removed by hand comes
   back at the next install or automatic refresh. The simplest behaviour consistent with
   "always on" is that uninstall is the one way to keep it out.
6. **Uninstall always ends ACC's claim.** It removes ACC's rule when it is there and drops
   the claim when it is not, so the same words added later by the operator stay theirs.
   While ACC stays installed, a rule that is present and claimed is ACC's; that is the one
   case ACC cannot tell apart from an operator removing ACC's rule and adding the same words
   between two installs, and uninstall then removes it.
7. **Ownership is recorded in ACC's data home**, beside the existing `created-*` markers:
   `<data home>/acc/adapter-antigravity/allow-rule-<base64url of the settings path>`, a JSON
   record of the file, the exact rule, and which of the file, `permissions` and
   `permissions.allow` ACC had to create. The claim is written before the rule, so a crash
   between the two leaves a claim uninstall drops rather than a rule nobody can attribute.
   Uninstall removes one copy of the recorded rule, then removes a container ACC created only
   if it is empty, and the file ACC created only if nothing is left in it. A rule the
   operator already had is never claimed.
8. **The operator's file is never rewritten when ACC cannot read it.** A file that does not
   parse, a top level that is not an object, a `permissions` that is not an object, or a
   `permissions.allow` that is not a list is left byte for byte. Install reports it as a
   needed action; uninstall keeps the claim so a later run can finish once the file is
   repaired. Every other key and allow entry is kept, and the file keeps its own formatting
   (two-space JSON with a trailing newline, as the client writes it).
9. **Doctor reports the rule as present, absent, or unable to apply.** Detection reports
   `commandApproval` - `allowed`, `prompts`, `unmatchable` or `unreadable`, with the rule and
   the file - and the same sentence as `inboundDelivery`, which `acc doctor` prints as
   `Antigravity CLI inbound: ...` for a client with live delivery on. Absent (`prompts`) now
   means ACC's install did not write the rule here or it was removed since: the line says a
   live wake stops at the agent's first ACC command, names the rule, `permissions.allow` and
   the file, and gives `acc install --adapter antigravity` as the remedy. Where ACC's wrapper
   is on disk, a missing or unreadable rule is also a remediation step, which doctor prints
   whatever the delivery policy. The adapter's own doctor and the JSON report carry the line
   in every state.
10. **No capability changes.** `delivery.livePush` stays as the 1.2.7 relay capture
    certified it. "A woken session answers without an approval prompt" is not claimed until
    the live capture below records it.

## The user's decision, 2026-09-27

The first version of this change asked the operator a separate default-No question at install
("Let ACC commands run without an approval prompt in Antigravity CLI?"), recorded the answer
as `deliveryDecision.allowCommands`, and wrote the rule only with live delivery on and a yes.
The user reviewed it the same day and decided: "remove this question altogether; let
everything always be enabled; there is no sense in something not being enabled." The question,
the recorded answer and the dependence on the delivery policy were removed; the rule is part
of the Antigravity integration, as its hooks are.

## What remains unverified

- The bare rule `command(<wrapper>)` matching `<wrapper> status|reply|inbox ...`. The
  captured match used the quoted one-word rule.
- A woken session answering a question with no prompt, end to end, with ACC's rule in place.
- A settings file that ACC creates because none existed: whether the client reads it and
  keeps it.
- Whether the client rewrites `settings.json` itself, for example when a folder is trusted,
  and keeps entries it did not write.
- Whether a model follows the skill's bare form every time, rather than adding quotes.
- Any version other than 1.2.12, and any platform other than macOS arm64.

The relay start command, `sh "<relay>" start`, is outside this rule. It runs once per
conversation, when the operator is present to approve it or has a rule of their own for it.

## Live capture still to do

Run with the user through the full end-to-end recipe: the candidate installed into an
isolated npm prefix with an isolated `ACC_DATA_HOME`, the real `agy`, and the real client homes
backed up before and restored after. Before install, remove the three capture rules from
`~/.gemini/antigravity-cli/settings.json`, keeping the operator's relay rule, and note the
bytes of that file and of `~/.gemini/settings.json`. Install the Antigravity adapter from the
candidate with no `--delivery` option and confirm it asks no approval-prompt question, that the
file gained exactly `command(<home>/.gemini/config/acc/acc-cli.sh)` and kept every other key,
that the claim is under `<ACC_DATA_HOME>/acc/adapter-antigravity/`, and that doctor reports the
rule as added by ACC. Restart `agy`, start the relay, send a question from a peer while the
session is idle and nobody is at the terminal, and confirm the agent's ACC commands use the
bare path, run with no prompt, and record the reply. Then uninstall and confirm both files are
back to their earlier bytes.
