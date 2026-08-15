# Product UX

## Installation

The intended installation experience is one command:

```bash
npx agents-can-communicate install
```

The installer detects supported clients, shows what it can configure, and asks once before changing user-level settings. Re-running it is idempotent.

Example result:

```text
Agents Can Communicate

✓ Codex detected       hooks + skill + MCP
✓ Claude Code detected hooks + skill + MCP
✓ Gemini CLI detected  extension + hooks + MCP
○ Generic MCP config   available

Installed 3 adapters. No project files were changed.
```

The exact package and binary names remain subject to publication checks.

## First session

The first supported session in a directory silently creates or discovers a Workspace and registers itself. The user asks an ordinary question; no ACC-specific phrase is required. A lone session leaves only ephemeral presence behind; durable Workspace state appears the moment a second session attaches or the first claim, message, or other durable object is created.

While the session is alone, the adapter injects nothing and asks nothing of the model: a simple solo task looks exactly as if ACC were not installed. Coordination context and the one-line Intent prompt appear at the first safe point after a second session attaches, and the model then announces its Intent through a high-level tool without asking the user to operate the protocol.

## Additional session

When a second client opens in the same Workspace, it attaches automatically and receives relevant awareness:

```text
Active participants:
- visual-codex: editing camera and lighting; file:game/presentation/**
- models-claude: exporting tank model v3; asset:tank-model/v3
No direct requests. No claim conflicts.
```

This context is normally hidden from the human-facing response.

## Any session answers for the whole system

The user may ask whichever chat is in front of them about the entire Workspace, and that session answers from shared state instead of claiming ignorance:

```text
User: what is happening in the project right now?
Claude: visual-codex is editing the camera (2 subagents: shaders,
lighting-review); physics-gemini is waiting for confirmation of the
tank-scale contract. No conflicts; one decision is waiting on you.
```

The same session can relay a request to any participant — “tell Gemini the contract is confirmed” becomes an ACC message with the human's authority attributed, delivered at the recipient's next safe point.

## Workstream joining policy

- Exact invitation: join automatically.
- Same explicit task or workstream identifier: join automatically.
- Exact conflicting resource: stop before mutation and ask or negotiate.
- Mere semantic similarity: inform the model, but do not silently merge work.
- Unrelated work: continue independently without user interruption.
- User says “work independently” or equivalent: remain independent while still respecting workspace-global claims.

## Creating a coordinator

A top-level session does not become global orchestrator merely because it opened first.

When the user requests delegation or the work genuinely benefits from coordinated participants, the session creates a Workstream. The creating session becomes that workstream's initial coordinator unless the user selects another participant.

The coordinator role is a renewable lease. Losing it cannot break storage, transport, claims, or already assigned tasks.

## Attention surfaces

Only actionable events should appear prominently:

```text
ACC: Claude is editing camera_rig.gd in workstream directed-visuals.
Your requested change overlaps that claim. Join the workstream or choose a
different scope?
```

```text
ACC: Gemini requested confirmation of the tank-scale contract.
```

Routine heartbeats, unrelated work, and successful syncs stay silent.

## Human status view

`acc status` provides a concise roster and work map:

```text
Workspace: Papercut Warzone 2

ACTIVE
visual-codex   edit     directed-visuals   game/presentation/**
models-claude  edit     tank-models        assets/tanks/**
physics-gemini review   suspension         game/sim/vehicle/**

ATTENTION
1 contract request awaiting models-claude
0 conflicts

PROTECTION
Codex: guarded   Claude: guarded   Gemini: guarded   MCP fallback: advisory
```

## Non-Git workspace

The same flow works in a plain directory. Branch, commit, and worktree fields are absent. File claims use canonical workspace-relative paths.

## Project configuration

No project config is required for ordinary use. Teams may add one later to share:

- stable workspace identity across moved or multi-root directories;
- role aliases;
- claim policies;
- adapter requirements;
- context budgets;
- workstream templates.

The config must never contain runtime presence, messages, locks, tokens, or transcripts.
