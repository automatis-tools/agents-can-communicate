# Changelog

## 0.0.0 — release candidate (unpublished)

Built and verified locally. **Not published**: no npm release, no tag, no GitHub
release.

| | |
|---|---|
| Built from | `d72b6a1` |
| Tarball | `agents-can-communicate-0.0.0.tgz`, 104 KB, 101 entries |
| sha256 | `efce17db97375af414baeffd315fb64d7eb6ddbd10b0f556c956fabb453de00b` |
| Tests | 670 passing, 0 failing |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — see below |

This is a measurement, not a promise about `main`. Every workspace travels inside the
tarball, so any change to shipped code changes the digest — and the commit named above is
necessarily an ancestor of the one recording it, because no commit can contain its own
hash. Only `bin/`, `README.md`, `LICENSE`, `docs/CAPABILITIES.md`, and the workspaces are
packed, so changes to tests, scripts, or the rest of `docs/` leave the digest alone.

To check it, or to record a newer candidate:

```bash
node scripts/verify-package.mjs
```

It prints the digest and the revision on one line, and refuses to imply reproducibility
when the working tree is dirty.

### What it does

Coordinates independent agent sessions in one workspace: presence, intent,
workspace-global claims, typed messages, handoffs. No session is in charge.

A peer's message reaches the recipient's turn as a fenced, attributed, escaped
block, and its receipt advances to `injected` only for what the turn actually
carried — a message the context budget could not fit stays queued rather than
telling the sender it landed. The ceiling is `policy.contextBudgetBytes`.

Claims are enforced however the workspace path is spelled. A project reached
through a symlink — `/tmp` and `/var` on macOS, a symlinked checkout anywhere —
used to pass every write through while still reporting `protection guarded`.

An agent can run the commands its skill teaches. Every mutating command took a
session id and a generation on the command line, and the skills told agents to
pass two environment variables nothing has ever set — so on all four native
clients the documented workflow could not be carried out at all. `acc` now works
out which session is running it, and stops rather than guessing when two live
sessions in one checkout both fit.

Installing edits configuration for four other tools, so uninstall removes the
entries ACC recorded writing and nothing else. A settings key ACC had to create
goes only when it is empty: plugins the user enabled afterwards live in that same
key, and taking it outright took them too.

### Clients

| Client | Version | Attach | Guard writes | Inject | Heartbeat |
|---|---|---|---|---|---|
| Codex | 0.147.0 | yes | yes¹ | yes | – |
| Claude Code | 2.1.233 | yes | yes | yes | – |
| Gemini CLI | 0.37.0, 0.55.1 | yes | yes² | yes | – |
| Kimi Code | 0.36.1 | yes | yes | yes | yes (60s) |
| Any MCP client | rev 2026-07-28 | yes | – | – | – |

A live model completed the full request loop on Codex - one session found who
owned the work, asked for it, and the other took it, fixed the code and reported
back. Claude Code attaches by itself and its agent used ACC's commands from the
skill. Kimi Code fired every hook and its model never ran: the account's quota is
spent. Gemini CLI fired every hook and its model never ran either: the account
returns a permission error in headless mode.

¹ only models that offer `apply_patch`; others edit through the shell, which
names no resource · ² only approval modes that expose edit tools

Full matrix and what the `yes` values do **not** promise:
[docs/CAPABILITIES.md](docs/CAPABILITIES.md).

### Known limitations

- **Kimi Code fires no `SessionEnd`.** Prompt-mode sessions age out on their 60s
  cadence, so a roster read inside that window shows sessions that have exited.
- **Codex needs hook trust.** ACC completes the install; trusting the plugin is
  the client's own step.
- **No shell guard is resource-aware.** A command names no path, so a claim
  cannot be matched against it. The turn context says so instead.
- **One unguardable participant makes the workspace advisory.** An MCP client or
  a shell-editing model means a guarded claim is advice, and status reports that.
- **Gemini headless returns 403 on the account used here.** Not ACC's doing —
  reproduced with a plain `gemini -p` outside ACC entirely. Headless runs also
  need `GEMINI_CLI_TRUST_WORKSPACE=true`.
- **No live model has driven Kimi Code or Gemini CLI.** Both fire every hook
  against the real client; neither account can complete a turn. Their matrix rows
  rest on hook captures, not on a finished exchange.
- **No subagent visibility.** `lifecycle.childSessions` is false everywhere; no
  subagent was observed during capture.
- **Windows does not work.** Not "untested" — measured. Once CI actually ran the
  suite there, 86 of 587 tests failed. Two root causes so far: the store fsyncs a
  directory after a rename for durability, which Windows refuses with `EPERM`,
  and `O_NOFOLLOW` does not refuse a symlinked config the way it does on POSIX —
  so the symlink defence does not hold. macOS and Linux are supported; Windows
  is future work.
- **Client capabilities were certified on macOS only.** Linux runs the suite in
  CI, but no adapter was exercised against a real client there.

### Not included

Remote coordination, process launching, push delivery, wake-on-message. All out
of scope for the first release.

### Before publishing

See [docs/RELEASING.md](docs/RELEASING.md). Publication, tagging, and a GitHub
release are deliberate acts and need explicit approval.
