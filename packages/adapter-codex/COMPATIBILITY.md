# Codex compatibility

Verified 2026-08-16 against the installed client and the material it ships.

| Item | Value |
|---|---|
| Client | `codex-cli` **0.147.0** (aarch64-apple-darwin standalone) |
| Primary docs | <https://learn.chatgpt.com/docs/plugins> (redirected from developers.openai.com/codex/plugins) |
| Local evidence | installed plugins under `~/.codex/plugins`, bundled `plugin-creator` skill |

## Verified plugin format

`.codex-plugin/plugin.json`, with these manifest keys confirmed by the bundled
`references/plugin-json-spec.md`:

`name`, `version`, `description`, `author`, `homepage`, `repository`, `license`,
`keywords`, `skills` (path), `hooks` (path), `mcpServers` (path **or** inline object),
`apps` (path), `interface` (presentation metadata).

Because `hooks` is a declared path rather than a fixed location, the plan's
`plugin/hooks/hooks.json` layout is compatible.

Hook file shape, taken from real installed plugins:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Bash",
  "hooks": [ { "type": "command", "command": "./scripts/x.sh" } ] } ] } }
```

## Verified hook events

Only these were observed in real installed plugins:

- `PostToolUse`
- `Stop`

## Open risks

1. **The hook event taxonomy is not published.** The official documentation states only
   that hooks are "commands that run at configured lifecycle points". No list of event
   names appears in the docs or in the material bundled with 0.147.0. `SessionStart` and
   `SessionEnd` are therefore **unverified**, and the adapter must not declare
   `lifecycle.sessionStart` or `lifecycle.sessionEnd` until a real session-boundary hook
   is observed firing.
2. **Hooks require persisted user trust.** The client exposes
   `--dangerously-bypass-hook-trust`, and the docs say "Review and trust plugin hooks
   before you enable them". Installation therefore cannot be silent: `acc install` can
   place the plugin, but the user must trust its hooks before any of them run, and
   `acc doctor` has to report the untrusted state rather than implying protection.
3. **Distribution is marketplace-based.** `codex plugin add` installs from a configured
   marketplace snapshot; the personal marketplace lives at
   `~/.agents/plugins/marketplace.json`. A file drop into a plugins directory is not the
   supported installation path.

## Consequence for the plan

`docs/superpowers/plans/2026-08-15-acc-adapters.md` Task 3 assumes session-start and
session-end hooks and a direct install. Until risk 1 is resolved by observation, the Codex
adapter attaches lazily on its first observed hook rather than at session start, and
declares no lifecycle capability.
