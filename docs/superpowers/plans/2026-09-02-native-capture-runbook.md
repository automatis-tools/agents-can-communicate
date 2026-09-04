# Native delivery captures: what the human does (2026-09-02, darwin-arm64)

The agent prepares and drives everything it may: the capture directory, the temporary
plugin `.mcp.json`, the `claude` shell shim, the Codex daemon (`daemon start`, undone by
`daemon stop`), every terminal-B injection, the real ACC records and receipt reads, the
observation logs, the fixtures, and the undo. The plan forbids automating three things:
accepting a vendor's own dialog, launching the ordinary client in the user's terminal,
and typing a normal user prompt. Those are the only steps below.

Nothing you type is recorded. Only ids, versions, timestamps, and branch outcomes go into
the fixtures.

## A. Claude Code (Task 2, Step 5)

1. Open a new terminal and paste the one line the agent gives you (it prepends a
   temporary shim directory to `PATH`, `cd`s into the repo, and runs plain `claude`).
2. Claude shows the full-screen development-channel warning: choose
   **"I am using this for local development"**. If it asks about a new MCP server
   `acc-channel`, choose **Use this MCP server**. The banner should mention
   *Channels (experimental) ... plugin:agents-can-communicate*.
3. Tell the agent "Claude up". It runs the idle, reply, and duplicate cases itself.
   You should see one `←` channel line appear by itself and Claude call `acc_reply`;
   the duplicate must **not** produce a second line.
4. When the agent says "busy now", paste this prompt and press Enter, then tell the
   agent "sent":
   `Count from 1 to 40, one number per line, with one short sentence about each number.`
   The agent injects a second question while you count. Afterwards tell it:
   did the `←` line appear, and did Claude act on it only **after** finishing the
   count (→ queued after the turn) or never (→ not presented)?
5. When the agent says "fallback", nothing to do: it kills the Channel child and proves
   the durable path from its own session. If Claude shows an MCP failure notice, that is
   expected.
6. When the agent says "done", exit Claude normally. The agent removes the shim and the
   plugin `.mcp.json`.

If you refuse the warning or the banner never appears, say so: that is an honest `fail`.

## B. Codex (Task 3, Step 5)

The agent already ran `codex app-server daemon start` (recorded as ACC-created; the
teardown is `daemon stop`).

1. Open another terminal and run:
   ```bash
   cd /Users/mmykola87/work/automatis-tools/agents-can-communicate && codex --remote unix://
   ```
   If the bare form is refused, use
   `codex --remote "unix://$HOME/.codex/app-server-control/app-server-control.sock"`.
2. Send one short prompt (`hello`) so a thread exists, wait for the answer, then tell
   the agent "Codex up". It discovers the exact thread, records a real ACC question, and
   queues it natively. Watch whether the queued question starts a turn **by itself** while
   Codex is idle, or only sits in the queue until you press something; tell the agent.
3. If Codex asks to approve running `acc reply ...`, approve it.
4. When the agent says "busy now", paste the same counting prompt, press Enter, tell the
   agent "sent", and afterwards say whether the queued question was presented and handled
   after the turn.
5. When the agent says "done", exit Codex normally. The agent stops the daemon and
   restores everything.

## C. Grok (optional)

Already recorded as an honest `fail` from the public surface. Only if you want the
two-client leader experiment: `grok agent leader` in one terminal, `grok` with
`[cli] use_leader = true` in two others, and tell the agent whether any public command lets
one client address a message into the other's session.
