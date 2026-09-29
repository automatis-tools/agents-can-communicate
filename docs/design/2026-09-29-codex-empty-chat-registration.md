# Registering an empty Codex chat

Issue #167. Measured on ACC 0.8.3, 2026-09-28 and 2026-09-29, with Codex CLI 0.158.0 and its
shared app-server daemon on macOS arm64.

## What was seen

A new Codex TUI loads its thread in the daemon at startup: `thread/loaded/list` names it, a
metadata-only `thread/read` returns `status: idle` and the project `cwd`, and
`locateCodexThread` finds it. `SessionStart` waits for the first turn, so until someone types,
ACC has no participant for the chat and no peer can address it.

A `thread/queue/add` into that untouched thread starts a turn 0.02 s later. In that turn the ACC
hooks opened a participant and the model answered. So the transport already works; what is
missing is a participant to address before the turn.

Three measurements settle what used to block this:

- **A closed chat closes itself.** The daemon unloads an idle thread with no subscribers about a
  minute after its TUI exits (Ctrl-C or `kill -9`) and runs `SessionEnd` as it does so, also
  for a thread that never had a turn (#212). A record ACC writes for an empty chat is therefore
  closed by the hook it already has, and the only orphan window is that minute.
- **Hook trust is readable.** `hooks/list` with `cwds` returns, per directory, each hook with
  `enabled`, `currentHash` and `trustStatus` (`trusted`, `managed`, `untrusted`, `modified`).
  ACC can tell whether its own hooks would run in a chat before it registers the chat.
- **The thread says what it is.** Metadata carries `parentThreadId` (a subagent), `ephemeral`,
  `status` and `cwd`, without reading any conversation.

## Decisions

1. **Discovery runs where a peer looks.** `acc status`, `acc doctor` and the MCP `acc_status`
   tool look for unregistered chats before they read status. A peer that is about to address
   someone runs one of these; the chat then appears in every later roster, including the
   hook context of other sessions. Hooks do not run discovery, so no turn of any client pays
   for it. It is bounded and fail-open: status never fails or waits long because of it.
2. **The adapter finds candidates.** Codex's `discoverNativeSessions` verifies the daemon
   (socket, protocol probe, and the pid in its PID record checked with `ps` and `lsof`, as
   service inspection already does) and lists loaded threads that are not subagents, not
   ephemeral, idle, and in a directory where ACC's `sessionStart`, `sessionEnd` and
   `userPromptSubmit` hooks are enabled and trusted or managed. With the fresh-home daemon
   layout (#205) it finds no pid and returns nothing.
3. **Registration is SessionStart without a turn.** The hook runner's `registerNativeSession`
   takes the same per-thread lifecycle lock as the hooks. If the thread already has an ACC
   binding it does nothing. Otherwise it writes what `SessionStart` writes: the thread's
   binding, a session for the participant the hook would name (derived from the thread id; a
   caller's `ACC_PARTICIPANT` never applies), the daemon's pid as the session's process, the
   native binding under the recorded live policy, and the native attempt. It writes no pin and
   produces no model output: the first real hook writes its own pin.
4. **Only this workspace.** A candidate registers only when its `cwd` resolves to the caller's
   workspace, the way a hook resolves it.
5. **The first hook adopts.** When the chat's first turn starts, whether from the user or from a
   peer's push, `SessionStart` finds the binding and resumes the same session through the
   existing path. No new code runs in the hook.

## What a peer sees

`acc status` lists the chat as a Codex participant with a live binding. A request to it is
offered through the daemon's queue, which starts the chat's first turn; the hook adopts the
session and the model answers. Two empty chats in one workspace are two participants, and a
push reaches only the addressed thread.

## Out of scope

- The orphan minute. A chat whose TUI exited less than a minute ago can still be registered and
  woken, exactly as a registered chat can (#212). No daemon field separates the two states.
- A daemon restart under an open chat, which leaves a session with a dead pid. That exists for
  hook-registered sessions too and has not been measured.
- The fresh-home daemon layout (#205).
