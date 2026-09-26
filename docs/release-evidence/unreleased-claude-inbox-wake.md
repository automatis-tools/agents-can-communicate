# Unreleased Claude Code inbox wake

Issue #130. ACC reached a busy or idle Claude Code session through the research-preview
Channels path: a `claude` shim on `PATH`, a development-channel flag, a Channel MCP server,
Anthropic authentication, and an organization setting on Team and Enterprise plans. This build
wakes the session through the inbox socket every Claude Code session binds, and delivers the
message through the next-turn hook that the wake fires.

## Transport capture, before any ACC code used the inbox

Claude Code 2.1.282, macOS arm64, 2026-09-25. A receiving TUI session in `auto` mode, with ACC
0.7.0 hooks and no Channel. A separate process wrote one JSON line per connection to the socket
the session registry named, with no auth line and no token.

| Observation | Result |
|---|---|
| Idle session | A new turn started with no user input. |
| Busy session, three sequential Bash calls | The frame was taken after the first call returned and before the second. The turn continued. |
| `UserPromptSubmit` | Fired for every delivered frame, idle and mid-turn. |
| ACC question, frame with ACC text only | The `beforeTurn` projection showed the question in its untrusted block. The model ran `acc reply`. The store recorded the answer and `acknowledged`. |
| Sender attests `from-mode="bypass"`, prompting receiver | Held with an approval dialog. Registry status `waiting`. Deny dropped the frame. |
| Six frames from six processes | All delivered. Five queued frames reached the model in one turn, each with its own `UserPromptSubmit`. |

Redacted record: `packages/adapter-claude-code/fixtures/inbox-wake-2.1.282.json`.

## Product capture of the installed candidate

`scripts/e2e/claude-inbox-candidate.mjs` built a private candidate from this branch (package
SHA-256 `fa81c55588988ed7274636c564a0adb5c442110f014f82e7a3f94da26fdd8891`) that enables the
inbox contract on the transport anchor. It was installed with an isolated ACC data home. The
plugin registration in the real Claude config directory was backed up first, and all 23 files
were restored byte for byte afterwards. Two Claude Code 2.1.282 TUI sessions ran in one
workspace, in `auto` mode, model Sonnet 5.

`scripts/e2e/claude-inbox-product.mjs` derived every observation from `acc message --json`,
`acc sync --scope full --json` and the receiving session's transcript records:

| Case | Observations | Outcome |
|---|---|---|
| C01 idle | delivery `woken`, wake `started-turn`, projection `body-shown`, offer `next-turn` | passed |
| C02 busy | delivery `woken`, wake `between-tool-calls`, projection `body-shown`, offer `next-turn` | passed |
| C03 reply | answer `recorded`, receipt `acknowledged` | passed |
| C04 duplicate | logical message `same-message-id`, wake `delivered-once` | passed |
| C05 fallback | client `exited`, delivery `queued` | passed |
| C06 exact binding | delivery `woken`, wake `started-turn`, other session `not-woken` | passed |

Capture and product evidence: `packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.282.json`
and `claude-code-2.1.282-product-evidence.json`. The capture's limitations name what it did
not cover: a receiver in `bypassPermissions` mode, `darwin-x64`, Linux and native Windows.

### Product runs on 2.1.283 and what they found

The capture above ran before the review fixes (`34e2439`), the Channel stub fix (`71f3db7`)
and the publication race fix (`7611b7e`). On 2026-09-26 the six cases ran again on the recorded
archive `8b6606eb…`, installed as shipped, with Claude Code 2.1.283; the 2.1.282 anchor carried
forward and all six passed. The same sessions were then taken through what those cases did not
cover, and each thing that did not work was fixed with a failing test first:

| Found in real sessions | Fix |
|---|---|
| A send replayed three times while the receiver was busy put three wakes in front of it; Claude Code does not drop a repeated `msg_id` | one wake per message and binding (`797cc80`) |
| A busy receiver called `SendMessage` to the sender's name, then `ListAgents` (94 sessions), before `acc reply` | the wake names `acc reply --message <id>` (`df17988`) |
| After `/resume` the bind refused with `native_session_unavailable`: Claude Code rewrites `sessions/<pid>.json` only after `SessionStart` | the bind checks process and socket; every wake still checks the session id (`8ba6a97`) |
| A `bypassPermissions` receiver held the wake in an approval dialog while the sender read `woke` | `pendingApproval` and a held message in the CLI; `refuse` sends no wake (`1723cd5`, `6b8fe9d`) |
| `acc doctor` never printed the inbound note | a `Claude Code inbound:` line when live delivery is on (`4b720e3`) |
| Every reply to a CLI sender printed `live offer unavailable (recipient_unavailable)` | `no_live_transport` (`73ca3e5`) |
| After `/clear` a message to the old participant said `recipient_unavailable`, and the participant left `acc status` | `recipient_offline` with `endReason: "clear"`, kept in status while messages wait (`0cd542e`) |

### Final run on the recorded candidate

2026-09-26, the archive `13363d63…` built from `6b8fe9d`, installed as shipped with an isolated
ACC data home, Claude Code 2.1.283 TUI sessions on Sonnet 5, the real Claude config backed up
first. One script ran every case in order. The archive recorded below differs from it in one
file, `packages/installer/src/ownership.mjs`, whose tree fingerprint now skips Claude Code's
`.orphaned_at` marker; no delivery code changed.

| Case | Observed | Outcome |
|---|---|---|
| C01 idle | `woken`, a turn started, body shown by the next-turn hook, one wake | passed |
| C02 busy | taken between two Bash calls, body shown, offer `next-turn` | passed |
| One message sent three times while busy | one wake frame | passed |
| C03 reply | answer recorded, receipt `acknowledged` | passed |
| C04 duplicate | same message id, one wake | passed |
| Claude to Claude | A asked B through ACC; B's `acc reply` printed `woke <A> via claude-inbox`; A got one wake and the answer `42` in its untrusted block | passed |
| C06 exact binding | only B woken | passed |
| `/clear` | the sender read `<B>'s conversation was cleared (/clear); the message waits until that conversation resumes`; JSON `recipient_offline`, `endReason: "clear"`; status `waiting for a closed session: <B> (cleared, 2)`; the new conversation woken once | passed |
| `/resume` before any prompt | the resumed conversation bound on `SessionStart` (`active`) and was woken once | passed |
| C05 fallback | `/exit`, then `queued` with `recipient_offline` | passed |
| `bypassPermissions` before any prompt | JSON `pendingApproval: true`; the sender read `which its session holds for approval`; Claude Code held it (`waiting`); after Deny the next turn carried the body | passed |
| `crossSessionInbound: "refuse"` in project settings | `delivery_disabled`, no wake frame, the session stayed idle; its next turn's hook showed the body | passed |
| `acc doctor` | printed the `Claude Code inbound:` line naming `crossSessionInbound` and the settings file | passed |
| `SendMessage` or `ListAgents` in any of the five transcripts | none; every answer went through the `acc` skill and `acc reply` | passed |

`scripts/e2e/claude-inbox-product.mjs finish` accepted C01 to C06 (6/6); its capture stays
uncommitted, because `fixtures/` is packed and the 2.1.282 capture certifies the contract. Two
checks in the script first reported failures that were the script's own: it read the refusing
session's transcript before that session had a first turn, and it expected the model to answer
an unrelated peer question, which it declined to do on its own. Read after the turn, the
transcript showed no wake and the body in the hook's block.

Afterwards 22 of the 23 backed-up files in the Claude config matched the backup byte for byte.
`known_marketplaces.json` differed only in the `lastUpdated` of the two git marketplaces
Claude Code refreshes on its own, with the `acc-local` entry unchanged. Starting a
`bypassPermissions` session had added `skipDangerousModePermissionPrompt` to the user's
`settings.json`; the restore took it out again.

## Upgrade from 0.7.x

`tests/acceptance/managed-update-degraded-packed.test.mjs` lays out what 0.7.x wrote for a live
Claude install: the Channel activation record, the `claude` shim and its `~/.zshrc` block, the
`acc-channel` `.mcp.json`, the `acc-bootstrap` and `acc-claude-channel` launchers, and the
bootstrap cache. A packed `acc update` with a client whose inbox probe fails removes every one
of them, keeps the recorded `actionable` consent and leaves no modified owned file. A later
`acc install` on a client that carries the inbox records the `claude-code-inbox-socket-v1`
activation.

`tests/process/legacy-shim-fails-open.test.mjs` runs a 0.7.x shim, rendered by that version's
own code, against a removed launcher and against the retired entrypoint stub. Both launch the
plain vendor command with its arguments byte for byte, without the development-channel flag.

A 0.7.x updater checks that a downloaded package has an entrypoint for each of its own entry
kinds. `packages/cli/test/managed-runtime-retired-kinds.test.mjs` pins that this package still
ships `acc-bootstrap` and `acc-claude-channel` entrypoints, as stubs. The same file pins that
the Channel stub exits on SIGTERM and on SIGINT while its parent still holds stdin open.

### Channel stub stop, local end to end

Run on darwin-arm64 against the candidate archive recorded from `71f3db7` (sha256
`f22cf626…`), with an isolated `HOME` and `ACC_DATA_HOME`. `bin/entrypoints/acc-claude-channel.mjs`
is byte-identical in the archive recorded below; the later changes are in code the stub never
loads. The variant "before the fix" is the same archive with
`bin/entrypoints/acc-claude-channel.mjs` taken from `4e02a15`.

- ACC 0.7.1 from npm ran `acc install --adapter claude_code`, then its own `acc update`
  activated the candidate from a local registry. The candidate's refresh removed the
  `acc-bootstrap` and `acc-claude-channel` launchers in that update, so an ordinary update
  never reaches the stub. The stub serves the state an interrupted 0.7.x refresh leaves:
  0.7.1's own launchers over the active candidate.
- Through that 0.7.1 launcher, 0.7.1 `runEntry` took an `acc-claude-channel` runtime lease and
  loaded the candidate's stub, which answered `initialize` with no tools. A signal sent while
  stdin stayed open:

  | Stub | SIGTERM | SIGINT |
  |---|---|---|
  | before the fix | still running after 5 s; exited only when stdin closed | the same |
  | fixed | exited in 3 ms, code 0 | exited in 3 ms, code 0 |

  The next admission (`acc status`) removed the lease of the exited stub.
- Claude Code 2.1.283 (`--bare` with no real credentials, `--mcp-config` naming the launcher
  as a 0.7.x `.mcp.json` does; the `stream-json` runs used a dummy key and a closed local API
  port, so no request left the machine) stops an MCP server with SIGINT, then SIGTERM about
  100 ms later, then SIGKILL. Before the fix the stub ignored the first two and was killed; fixed, it exited with
  code 0 within 1 ms of SIGINT. On `mcp_reconnect` in a live `stream-json` session the
  replacement started about 530 ms after SIGINT before the fix and about 74 ms after it with
  the fix. On `mcp_toggle` disable Claude Code sends no signal and keeps stdin open, so either
  stub runs until Claude Code exits. No stub process remained after any run.

## Candidate archive

`node scripts/verify-package.mjs` on `97d80045b31ab93a18f51831471e9b3d7db1cce1`, after the
review fixes, the Channel stub and publication race fixes, every fix the product runs above
led to, and the plugin cache ownership fix. A separate `npm pack` of the same commit gives the
same digest, 468,697 bytes:

```text
== pack
   ok  sha256 54e224cd4da725d1806570f492957abe89cb605646a2b4d46f5ae6530e4fab8c
== tarball contents
   ok  311 entries, none forbidden
   ok  6 certification manifest(s), exact evidence allowlist shipped
   ok  every packed Markdown link resolves inside the tarball
== install into a clean directory
   ok  acc, acc-hook, acc-mcp
== doctor
   ok  6 adapter(s) reported
== a workspace with no Git
   ok  1 participant(s), 1 claim(s)
   ok  nothing written into the project
== install and uninstall
   ok  client-home topology, modes, links, and bytes restored; repeated uninstall was a no-op
PASS
```

## Test suite

`npm test` on `5cd8841` (the recorded candidate plus its CHANGELOG record): 2580 tests, 2579
passing, 1 skipped, 0 failing.
