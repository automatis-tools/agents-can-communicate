# ACC Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver capability-truthful integrations for generic MCP, Codex, Claude Code, and Gemini CLI that attach independent sessions to the standalone ACC core with minimal user effort.

**Architecture:** A shared adapter SDK defines detection, reversible installation, hook normalization, context projection, and conformance tests. Native packages translate official harness events into stable CLI/core operations; MCP remains a polling fallback and does not claim lifecycle guarantees.

**Tech Stack:** Node.js ESM, Node built-in tests, official client plugin/extension formats, MCP stdio server.

**Spec:** `docs/superpowers/specs/2026-08-15-standalone-acc-design.md` §7 plus `docs/ADAPTERS.md` (capability matrix, tiers, and conformance suite).

## Global Constraints

- Precondition: the complete core extraction plan is green.
- Verify current official hook/plugin schemas before implementing each adapter; pin every manifest version actually used.
- **Verification completed 2026-08-16** against MCP revision `2026-07-28`, `codex-cli 0.147.0`, Claude Code `2.1.233`, and Gemini CLI `0.37.0`. Findings and divergences are recorded in each package's `COMPATIBILITY.md` and take precedence over the task text below where they disagree. Two divergences change the work: the MCP session model in Task 2 (the `initialize`-scoped session is invalid under a stateless protocol) and Codex lifecycle hooks in Task 3 (the event taxonomy is unpublished, so session-start and session-end remain unverified).
- Do not scrape terminal panes or raw transcripts.
- False is the default for every capability.
- Installer changes are idempotent, preserve unrelated user configuration, and are exactly reversible.
- Keep model-facing operations to the six high-level ACC tools.
- Retain real-client evidence for every capability marked true.
- Every adapter skill instructs the model to publish Intent, to answer whole-Workspace questions from `sync`/`status` data — including other vendors' sessions and their subagents — and to relay user requests to other participants as ACC messages, instead of claiming it cannot see other models (peer equality, approved 2026-08-15).
- Solo sessions are zero-overhead (approved 2026-08-15): when the Workspace has no peers and no attention items, adapters inject no coordination context — zero bytes, not a "none" banner — and guards short-circuit; coordination surfaces at the first safe point after a peer attaches.

---

### Task 1: Build adapter SDK and conformance kit

**Files:**
- Create: `packages/adapter-sdk/package.json`
- Create: `packages/adapter-sdk/src/capabilities.mjs`
- Create: `packages/adapter-sdk/src/context-projector.mjs`
- Create: `packages/adapter-sdk/src/config-merge.mjs`
- Create: `packages/adapter-sdk/src/session-binding.mjs`
- Create: `packages/adapter-sdk/src/index.mjs`
- Create: `packages/adapter-sdk/test/capabilities.test.mjs`
- Create: `packages/adapter-sdk/test/context-projector.test.mjs`
- Create: `packages/adapter-sdk/test/session-binding.test.mjs`
- Create: `tests/conformance/adapter-contract.mjs`

**Interfaces:**
- Produces `defineAdapter`, `assertCapabilities`, `projectContext`, `mergeOwnedConfig`, `storeSessionBinding`, `loadSessionBinding`, `clearSessionBinding`, and `runAdapterConformance`

`defineAdapter` returns this contract:

```js
{
  id, displayName, capabilities,
  detect(context), install(context), uninstall(context), doctor(context),
  normalizeHook(input), renderContext(syncResult)
}
```

Each operation returns `{ ok, changes, diagnostics }`; `normalizeHook` returns `{ kind, sessionId, cwd, model, parentSessionId, tool }` with nullable optional fields.

Hook executables are ephemeral processes, so the SDK also persists the harness-to-ACC session mapping under the runtime directory (never the project):

```js
storeSessionBinding({ runtimeDir, harnessSessionId, accSessionId, generation }): Promise<void>
loadSessionBinding({ runtimeDir, harnessSessionId }): Promise<{ accSessionId, generation } | null>
clearSessionBinding({ runtimeDir, harnessSessionId }): Promise<void>
```

Every hook after session start loads the binding to reuse the exact session generation; `clearSessionBinding` runs at session end.

- [ ] **Step 1: Write capability RED**

```js
test("a true capability requires an implementation method", () => {
  assert.throws(() => defineAdapter({
    capabilities: { guards: { beforeWrite: true } },
  }), /guardWrite/);
});
```

Add tests that omitted capabilities resolve to false and unknown capability keys fail validation.

- [ ] **Step 2: Write context-budget RED**

Create a `SyncResult` larger than the configured byte budget. Assert direct requests and conflicts remain, routine roster detail becomes references, and output is deterministic. Include one hostile peer message containing fake system instructions and terminal escape sequences: the projected output must keep sender attribution and message-type labels, escape control sequences, and confine peer text to a clearly delimited data block that cannot read as ACC policy (`docs/SECURITY.md` rendering properties). Add the solo case: a `SyncResult` with no peers and no attention items projects to an empty string — zero bytes, never a "none" banner.

- [ ] **Step 3: Run RED**

```bash
node --test packages/adapter-sdk/test/*.test.mjs
```

- [ ] **Step 4: Implement SDK**

`defineAdapter` freezes the manifest. `mergeOwnedConfig` stores an ACC ownership marker and removes only owned entries on uninstall. Session bindings are single JSON files written atomically under the runtime directory. `projectContext` escapes terminal control sequences and renders peer content inside attributed data blocks.

- [ ] **Step 5: Implement conformance runner**

The runner accepts adapter factory plus fixture harness and checks detection, double install, unrelated-config preservation, normalization, context budgets, injection-safe peer rendering, session-binding reuse across two consecutive hook events, solo zero-overhead (empty projection and guard short-circuit when no peers and no claims exist), declared capabilities, double uninstall, and cleanup.

- [ ] **Step 6: Mutation proof and commit**

Temporarily default `beforeWrite` to true. The omitted-capability test must fail. Restore.

```bash
git add packages/adapter-sdk tests/conformance
git commit -m "feat: define harness adapter contract"
```

---

### Task 2: Implement generic MCP fallback

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/src/server.mjs`
- Create: `packages/mcp-server/src/tools.mjs`
- Create: `packages/mcp-server/src/resources.mjs`
- Create: `packages/mcp-server/test/server.test.mjs`
- Create: `packages/mcp-server/test/tools.test.mjs`
- Create: `packages/mcp-server/COMPATIBILITY.md`
- Create: `bin/acc-mcp.mjs`

**Interfaces:**
- Produces MCP tools `acc_sync`, `acc_work`, `acc_claim`, `acc_message`, `acc_task`, `acc_finish`
- Produces read-only resources for Workspace snapshot, roster, workstream, task, and inbox

- [ ] **Step 1: Choose and record the MCP transport implementation**

Decide explicitly between a dependency-free JSON-RPC 2.0 stdio implementation targeting the current MCP specification revision and the official `@modelcontextprotocol/sdk` verified from its primary source and pinned exactly (the AGENTS.md dependency rule). Record the choice, the MCP protocol revision, and any pinned version in `packages/mcp-server/COMPATIBILITY.md`.

- [ ] **Step 2: Write MCP surface RED**

Start the stdio server in a test client. Assert exactly six public tools, strict JSON schemas, and descriptions that state polling semantics.

- [ ] **Step 3: Run RED**

```bash
node --test packages/mcp-server/test/*.test.mjs
```

- [ ] **Step 4: Implement thin tool translation**

Each tool maps one request into a high-level core operation and returns structured content plus stable machine data. Tool code contains no duplicate claim or lifecycle rules.

Session identity: the server opens one ACC session during the MCP `initialize` handshake (participant name derived from `clientInfo`, Workspace discovered from the server's launch directory), heartbeats it on every tool call, and closes it on stdin EOF or a termination signal. Conversation boundaries inside the client remain unobservable, so the capability manifest still declares no lifecycle capability — process attach is what actually happens, and `acc status` must label it that way.

- [ ] **Step 5: Add hostile peer-content test**

Store a message containing fake system instructions and terminal escapes. The resource output must preserve attribution and escape display control sequences rather than promoting text to protocol policy.

- [ ] **Step 6: Add polling truthfulness test**

The adapter manifest declares `polling: true`, `activeNotification: false`, `wakeDormantSession: false`, and no lifecycle or guard capabilities.

- [ ] **Step 7: Verify and commit**

```bash
node --test packages/mcp-server/test/*.test.mjs
git add packages/mcp-server bin/acc-mcp.mjs
git commit -m "feat: add generic MCP coordination fallback"
```

---

### Task 3: Implement Codex native adapter

**Files:**
- Create: `packages/adapter-codex/package.json`
- Create: `packages/adapter-codex/src/adapter.mjs`
- Create: `packages/adapter-codex/src/install.mjs`
- Create: `packages/adapter-codex/src/hooks.mjs`
- Create: `packages/adapter-codex/plugin/.codex-plugin/plugin.json`
- Create: `packages/adapter-codex/plugin/skills/acc/SKILL.md`
- Create: `packages/adapter-codex/plugin/hooks/hooks.json`
- Create: `packages/adapter-codex/test/adapter.test.mjs`
- Create: `packages/adapter-codex/test/hooks.test.mjs`
- Create: `packages/adapter-codex/test/install.test.mjs`
- Create: `tests/conformance/codex.test.mjs`
- Create: `packages/adapter-codex/COMPATIBILITY.md`

**Interfaces:**
- Consumes: adapter SDK and CLI
- Produces: installable Codex plugin with observed capability manifest

- [ ] **Step 1: Verify official Codex extension schema**

Record the exact installed Codex version and primary documentation URLs in `packages/adapter-codex/COMPATIBILITY.md`. Update the proposed file map if the official manifest path differs; do not emulate another vendor's schema.

- [ ] **Step 2: Write fixture RED**

Use captured official hook fixtures for session start, supported pre-tool events, safe-point delivery, and session end. Assert normalized `sessionId`, `cwd`, `model`, tool target, parent ID, and event kind.

- [ ] **Step 3: Write install RED**

Given existing unrelated plugin/settings entries, install twice then uninstall twice. Assert unrelated bytes/semantic values remain and ACC entries are absent after uninstall.

- [ ] **Step 4: Implement adapter and plugin**

Session start runs attach/sync; skill instructs the model to publish Intent; supported pre-tool hooks call guard; safe points sync attention; end closes exact generation. Mark only observed capabilities true.

- [ ] **Step 5: Real-session liveness**

Open two Codex sessions in one temp Workspace. Prove auto-attach, Intent publication, one direct message, one conflicting claim block where declared, clean close, and exact delivery state. Retain machine artifacts under `build/acceptance/codex/`, not Git.

- [ ] **Step 6: Conformance and commit**

```bash
node --test packages/adapter-codex/test/*.test.mjs tests/conformance/codex.test.mjs
git add packages/adapter-codex tests/conformance/codex.test.mjs
git commit -m "feat: integrate Codex sessions"
```

---

### Task 4: Implement Claude Code native adapter

**Files:**
- Create: `packages/adapter-claude-code/package.json`
- Create: `packages/adapter-claude-code/src/adapter.mjs`
- Create: `packages/adapter-claude-code/src/install.mjs`
- Create: `packages/adapter-claude-code/src/hooks.mjs`
- Create: `packages/adapter-claude-code/plugin/.claude-plugin/plugin.json`
- Create: `packages/adapter-claude-code/plugin/skills/acc/SKILL.md`
- Create: `packages/adapter-claude-code/plugin/hooks/hooks.json`
- Create: `packages/adapter-claude-code/test/adapter.test.mjs`
- Create: `packages/adapter-claude-code/test/hooks.test.mjs`
- Create: `packages/adapter-claude-code/test/install.test.mjs`
- Create: `tests/conformance/claude-code.test.mjs`

**Interfaces:**
- Consumes: adapter SDK and CLI
- Produces: Claude Code plugin mapping top-level, teammate, and subagent sessions

- [ ] **Step 1: Capture official hook fixtures and write RED**

Cover `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, `SessionEnd`, `SubagentStart`, and `SubagentStop`. Verify which are advisory and which can block according to the installed version.

- [ ] **Step 2: Write child-visibility RED**

A short child with no task/claim/external message stays collapsed. A child that acquires a claim becomes a visible nested Session. Both retain parent identity.

- [ ] **Step 3: Implement reversible config merge**

Use ownership markers and preserve unrelated `.claude` settings. Hook stdout follows Claude's exact structured-output rules.

- [ ] **Step 4: Implement lifecycle and guards**

Do not rely on `SessionEnd` to synthesize semantic handoff. `Stop`/skill calls `finish` while the model is active; `SessionEnd` only closes lifecycle ownership.

- [ ] **Step 5: Real-session liveness**

Open independent Claude Code and Codex sessions. Prove mutual roster visibility, direct request/ack, and global claim conflict without using Claude Agent Teams. Then prove one Claude child appears only after taking globally relevant work.

- [ ] **Step 6: Conformance and commit**

```bash
node --test packages/adapter-claude-code/test/*.test.mjs tests/conformance/claude-code.test.mjs
git add packages/adapter-claude-code tests/conformance/claude-code.test.mjs
git commit -m "feat: integrate Claude Code sessions"
```

---

### Task 5: Implement Gemini CLI native adapter

**Files:**
- Create: `packages/adapter-gemini-cli/package.json`
- Create: `packages/adapter-gemini-cli/src/adapter.mjs`
- Create: `packages/adapter-gemini-cli/src/install.mjs`
- Create: `packages/adapter-gemini-cli/src/hooks.mjs`
- Create: `packages/adapter-gemini-cli/extension/gemini-extension.json`
- Create: `packages/adapter-gemini-cli/extension/hooks/hooks.json`
- Create: `packages/adapter-gemini-cli/extension/skills/acc/SKILL.md`
- Create: `packages/adapter-gemini-cli/test/adapter.test.mjs`
- Create: `packages/adapter-gemini-cli/test/hooks.test.mjs`
- Create: `packages/adapter-gemini-cli/test/install.test.mjs`
- Create: `tests/conformance/gemini-cli.test.mjs`

**Interfaces:**
- Consumes: adapter SDK and CLI
- Produces: installable Gemini extension and observed capability manifest

- [ ] **Step 1: Capture official hook fixtures and write RED**

Cover `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, and `SessionEnd`. Assert hook stdout is one JSON object with no plain-text pollution.

- [ ] **Step 2: Write extension install RED**

Install into a fixture containing unrelated settings and extension data. Assert requested environment variables are explicitly declared and secrets are neither copied nor persisted.

- [ ] **Step 3: Implement extension and adapter**

Use `BeforeAgent` for bounded delta context, `BeforeTool` for declared guards, and `AfterAgent` for post-turn sync/finish prompts. Map Gemini subagents to nested Sessions using documented metadata only.

- [ ] **Step 4: Real-session liveness**

Open Gemini beside existing Codex and Claude sessions. Prove automatic attach, three-party roster, Intent, one request/response/ack chain, and clean lifecycle closure.

- [ ] **Step 5: Conformance and commit**

```bash
node --test packages/adapter-gemini-cli/test/*.test.mjs tests/conformance/gemini-cli.test.mjs
git add packages/adapter-gemini-cli tests/conformance/gemini-cli.test.mjs
git commit -m "feat: integrate Gemini CLI sessions"
```

---

### Task 6: Certify cross-vendor behavior

**Files:**
- Create: `tests/acceptance/cross-vendor.md`
- Create: `tests/acceptance/non-git.md`
- Create: `docs/CAPABILITIES.md`

**Interfaces:**
- Consumes: all four adapters
- Produces: first complete capability matrix and retained acceptance recipe

- [ ] **Step 1: Run three-client Workspace scenario**

Use one real Codex, Claude Code, and Gemini CLI session. Verify silent attach, distinct Intents, unrelated work without prompts, global claim conflict, direct message, decision, artifact, handoff, and final zero-live state.

- [ ] **Step 2: Run non-Git scenario**

Repeat attach, Intent, claim, message, and close in a plain temporary directory. Assert no Git command failure reaches the user and no runtime state appears in the directory.

- [ ] **Step 3: Run MCP-only degradation scenario**

Connect a generic MCP client. Verify it can sync and collaborate while status explicitly labels lifecycle and guards advisory/unavailable.

- [ ] **Step 4: Publish exact capability matrix**

`docs/CAPABILITIES.md` records observed client versions, tested operating systems, and true/false capabilities. No capability may be inferred from documentation alone.

- [ ] **Step 5: Complete verification and commit**

```bash
npm test
npm run check
git diff --check
git add tests/acceptance docs/CAPABILITIES.md
git commit -m "test: certify cross-vendor coordination"
```
