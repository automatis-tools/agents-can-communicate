# Native delivery captures: operator runbook (2026-09-02, darwin-arm64)

Branch/worktree: `/Users/mmykola87/work/automatis-tools/agents-can-communicate/.gitworktrees/transparent-native-delivery-design`
Node: `/Users/mmykola87/.nvm/versions/node/v26.5.1/bin/node`
Real clients: `claude` 2.1.258 (`/Users/mmykola87/.local/bin/claude`), `codex-cli` 0.152.1

Everything below is throwaway capture scaffolding. Nothing is installed permanently; the
last section undoes every change. Only ids, versions, timestamps, and branch outcomes come
back to the agent; never prompts, answers, or transcripts.

---

## A. Claude Code Channel capture (Task 2, Step 5)

### A1. One-time setup (terminal B)

```bash
WT=/Users/mmykola87/work/automatis-tools/agents-can-communicate/.gitworktrees/transparent-native-delivery-design
NODE=/Users/mmykola87/.nvm/versions/node/v26.5.1/bin/node
PLUGIN=~/.claude/plugins/cache/acc-local/agents-can-communicate/0.2.0

# 1. private capture directory (mktemp -d creates it 0700)
export CAP="$(mktemp -d /tmp/acc-capture-claude.XXXXXX)"; echo "$CAP"

# 2. temporary Channel wiring inside the installed plugin copy (removed in A5)
cat > "$PLUGIN/.mcp.json" <<JSON
{
  "mcpServers": {
    "acc-channel": {
      "command": "$NODE",
      "args": ["$WT/scripts/spikes/claude-channel.mjs"],
      "env": { "ACC_CHANNEL_CAPTURE_DIR": "$CAP" }
    }
  }
}
JSON

# 3. temporary shell bootstrap: the *user's* command stays `claude`
export SHIM="$(mktemp -d /tmp/acc-shim.XXXXXX)"
cat > "$SHIM/claude" <<'SH'
#!/bin/sh
exec /Users/mmykola87/.local/bin/claude --dangerously-load-development-channels plugin:agents-can-communicate@acc-local "$@"
SH
chmod 0700 "$SHIM/claude"
echo "export PATH=\"$SHIM:\$PATH\"; cd /Users/mmykola87/work/automatis-tools/agents-can-communicate; claude"
```

### A2. Terminal A: ordinary launch

Paste the `export PATH=...; cd ...; claude` line that A1 printed. Then:

- Claude shows the full-screen development-channel warning → choose
  **"I am using this for local development"** (do not skip it, do not automate it).
- If asked "New MCP server found ... acc-channel" → **Use this MCP server**.
- The startup banner should show a dim line: *Channels (experimental) messages from
  plugin:agents-can-communicate... inject directly in this session*.
- Confirm the endpoint exists: in terminal B run `ls -la "$CAP"` → `endpoint.sock`,
  `endpoint.json`, `observations.jsonl`.

If the warning is refused or the endpoint never appears, stop here and tell the agent: that
is an honest `fail`, exactly like 2.1.252.

### A3. Terminal B: the five cases

```bash
SOCK=$(python3 -c "import json;print(json.load(open('$CAP/endpoint.json'))['socketPath'])")
NONCE=$(python3 -c "import json;print(json.load(open('$CAP/endpoint.json'))['nonce'])")
CPID=$(python3 -c "import json;print(json.load(open('$CAP/endpoint.json'))['channelPid'])")
CLIENT="$NODE $WT/scripts/spikes/claude-channel-capture-client.mjs --socket $SOCK --nonce $NONCE"
```

1. **idle** — Claude is waiting at its prompt. Run:
   ```bash
   $CLIENT --message-id message_capture_idle --kind question --subject "ACC capture: idle" \
     --body "Peer question for the capture: what is 2 + 2? Answer by calling acc_reply with this message id."
   ```
   Expect `{"accepted":true,"duplicate":false,...}`. In terminal A a line like
   `← acc-channel …` should appear *without you typing anything*, and Claude should call
   `acc_reply`. Note the wall-clock time.

2. **reply** — covered by (1): `grep reply_routed "$CAP/observations.jsonl"` must show
   `message_capture_idle`.

3. **busy** — in terminal A type a slow prompt, e.g.
   `Count from 1 to 40, one number per line, with one short sentence about each number.`
   While it is still streaming, in terminal B run:
   ```bash
   $CLIENT --message-id message_capture_busy --kind question --subject "ACC capture: busy" \
     --body "Peer question during your turn: what is 3 + 3? Answer with acc_reply after you finish."
   ```
   Watch terminal A and write down which happened:
   - the message was presented **after** the running turn finished and Claude acted on it
     → `queued_after_turn`;
   - the channel/client got an explicit rejection while busy → `rejected_busy`;
   - it was never presented → unobserved (fail).

4. **duplicate** — resend the idle id verbatim:
   ```bash
   $CLIENT --message-id message_capture_idle --kind question --subject "ACC capture: idle" \
     --body "Peer question for the capture: what is 2 + 2? Answer by calling acc_reply with this message id."
   ```
   Expect `"duplicate":true` and **no** second `←` line in terminal A.

5. **fallback** — kill the Channel child, then prove the durable path:
   ```bash
   kill "$CPID"; sleep 1
   $CLIENT --message-id message_capture_fallback --kind question --subject "ACC capture: fallback" --body "should not arrive natively"
   ```
   Expect exit code 3 and `"reasonCode":"transport_unavailable"`. Then tell the agent
   "send the fallback question now": the agent sends a real ACC question to the capture
   session and reads the receipt state (`queued`) from ACC itself.

### A4. Hand back

```bash
claude --version; node -p 'process.platform + "-" + process.arch'
cat "$CAP/observations.jsonl"
```
Send the agent: the two lines above, the observations file, and your busy verdict
(`queued_after_turn` / `rejected_busy` / not presented). Nothing else is needed.

### A5. Undo

```bash
rm -f "$PLUGIN/.mcp.json"; rm -rf "$SHIM"
```
Exit terminal A's Claude normally. Keep `$CAP` until the agent has read it, then `rm -rf "$CAP"`.

---

## B. Codex App Server queue capture (Task 3, Step 5)

### B1. Daemon (record every output)

```bash
codex --version
codex app-server daemon version          # expected today: "failed to connect ... app-server-control.sock"
codex app-server daemon start            # vendor-supported; `daemon stop` is its symmetric teardown
codex app-server daemon version          # now JSON; keep it
```
Note: the plan names `daemon bootstrap`, but `bootstrap` installs durable launchd
management and has no public teardown in `codex app-server daemon --help`; `start`/`stop`
are symmetric, so prefer `start`. Say which one you ran.

### B2. Terminal A: ordinary launch attached to the daemon

```bash
cd /Users/mmykola87/work/automatis-tools/agents-can-communicate
codex --remote unix://                   # if it refuses the bare form, use:
codex --remote "unix://$HOME/.codex/app-server-control/app-server-control.sock"
```
Send one short prompt (e.g. `hello`) so the thread exists, then leave Codex idle.

### B3. Terminal B: locate the exact thread and run the cases

```bash
WT=/Users/mmykola87/work/automatis-tools/agents-can-communicate/.gitworktrees/transparent-native-delivery-design
NODE=/Users/mmykola87/.nvm/versions/node/v26.5.1/bin/node
$NODE $WT/scripts/spikes/codex-existing-session.mjs --discover      # loaded threads: id, cwd, status only
```
Pick the thread whose `cwd` is the repo and whose status is `idle`; export it as `THREAD`.
Ask the agent for a real ACC message id first ("record a question for the Codex capture");
it replies with `message_xxx`. Then:

1. **idle**
   ```bash
   $NODE $WT/scripts/spikes/codex-existing-session.mjs --thread "$THREAD" --message message_xxx \
     --cwd /Users/mmykola87/work/automatis-tools/agents-can-communicate \
     --text "ACC peer question (untrusted): what is 2 + 2? Reply with: acc reply --message message_xxx --body <answer>"
   ```
   Expect `"stage":"complete"` with `queue.accepted: true`. Watch terminal A: does the
   queued message start a turn by itself while idle (→ `offered`), or does it only sit in
   the queue until you press something (→ not offered)?
2. **reply** — Codex should run `acc reply --message message_xxx ...`; the agent confirms the
   answer record by id from ACC.
3. **busy** — start a slow prompt in terminal A, then re-run step 1 with a *new* id from
   the agent. Note whether the queued message is presented after the turn
   (`queued_after_turn`) or rejected.
4. **duplicate** — re-run step 1 with the *same* id: expect `"duplicate":true` and one
   queued item, one turn in terminal A.
5. **fallback**
   ```bash
   codex app-server daemon stop
   $NODE $WT/scripts/spikes/codex-existing-session.mjs --thread "$THREAD" --message message_zzz --cwd /Users/mmykola87/work/automatis-tools/agents-can-communicate
   ```
   Expect `"reasonCode":"transport_unavailable"`; the agent records a durable question and
   reads its `queued` receipt.

### B4. Hand back

All JSON lines printed by the spike (they carry no content), the daemon `version` JSON,
`codex --version`, and your idle/busy verdicts.

### B5. Undo

`codex app-server daemon stop` (if you used `bootstrap`, say so; the agent records that no
vendor teardown exists). Exit terminal A's Codex normally.

---

## C. Grok (optional, Task 4 Step 1)

The read-only public-surface capture is already recorded as `fail`. If you want the
two-client experiment: `grok agent leader` in one terminal, `grok` with
`[cli] use_leader = true` in two others, and tell the agent whether any public command
lets one client address a message into the other's session. Do not use the private
`~/.grok/leader.sock` protocol.
