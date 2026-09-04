# Release captures on the installed tarball (Task 13, Step 8)

Everything else in the plan is done and green; this is the only remaining step, and it is
interactive by design. It installs the *built tarball* into a throwaway prefix and home,
opts Claude and Codex into `actionable`, and proves a real Claude<->Codex exchange through
the shipped adapters - not the worktree spikes.

The agent prepares the daemon, the ACC bookkeeping, and the checks; you accept the vendor
dialogs, launch the ordinary commands, and type one prompt.

## Prepare (agent or you)

```bash
WT=/Users/mmykola87/work/automatis-tools/agents-can-communicate/.gitworktrees/transparent-native-delivery-design
PREFIX="$(mktemp -d /tmp/acc-rel-prefix.XXXX)"
HOME2="$(mktemp -d /tmp/acc-rel-home.XXXX)"          # throwaway client home
cd "$WT" && npm pack --pack-destination "$PREFIX"
npm i -g --prefix "$PREFIX" "$PREFIX"/agents-can-communicate-0.2.0.tgz
export PATH="$PREFIX/bin:$PATH"                       # the installed acc
acc --version                                        # 0.2.0 from the tarball
codex app-server daemon start                        # vendor daemon for Codex
```

## Opt in (interactive)

```bash
acc install --adapter claude_code --adapter codex --delivery actionable --home "$HOME2"
```

- The install writes an owned zsh PATH block + shims and, for Claude, the plugin `.mcp.json`.
- Open a NEW terminal (or `source "$HOME2/.zshrc"`), and `export PATH` again if needed.

## Prove bidirectional (interactive + agent)

1. Terminal A: `claude` (accept the development-channel warning; "Use this MCP server").
2. Terminal B: `codex --remote unix://` in the same project; send `hello`.
3. Tell the agent both are up. The agent, from a third ACC session:
   - has Claude send an ACC question to Codex and confirms Codex answered without a new human
     prompt (`acc reply`), and the answer reached Claude natively;
   - resends the same message id and confirms no duplicate model-visible message;
   - during a busy turn, confirms the queued message is presented after the turn or rejected;
   - kills each transport and confirms the next durable message stays `queued`;
   - runs `ACC_BYPASS=1 claude` / `ACC_BYPASS=1 codex` and confirms no native args;
   - runs `acc doctor` and reads the native-delivery state lines.

Capture ids, versions, timestamps, and branch outcomes only - never prompts or answers. If
the installed artifact differs from the spike on any required branch, set the capability
back to false, record the failure, and stop before release.

## Undo

```bash
acc uninstall --adapter claude_code --adapter codex --home "$HOME2"   # restores bytes, keeps the vendor daemon
codex app-server daemon stop
npm rm -g --prefix "$PREFIX" agents-can-communicate
rm -rf "$PREFIX" "$HOME2"
```

`acc uninstall` restores the owned zsh/plugin bytes byte-for-byte and leaves the pre-existing
Codex daemon in place (ACC never created it).
