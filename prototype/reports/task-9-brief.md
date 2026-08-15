### Task 9: Canonical bootstrap prompt and operator documentation

**Files:**

- Create: `tools/agents/lib/prompt.mjs`
- Create: `tests/tools/agent_comms/prompt.test.mjs`
- Create: `docs/AGENT_COMMS.md`
- Create: `docs/AGENT_COMMS_PROMPT.md`
- Modify: `AGENTS.md`
- Modify: `.gitignore`
- Modify: `tools/agents/comms.mjs`

**Interfaces:**

- Produces `renderPrompt({ templatePath, agentId, role, task, ownership }) -> Promise<string>`.
- Template contains exactly `<AGENT_ID>`, `<ROLE>`, `<TASK>`, and `<OWNERSHIP>` as replaceable tokens.
- CLI command is `node tools/agents/comms.mjs prompt --id visual --role visual --task M2.7 --ownership game/presentation`.

- [ ] **Step 1: Write prompt contract tests**

```js
test("rendered prompt is the committed template with literal substitutions", async () => {
  const template = await readFile(templatePath, "utf8");
  const rendered = await renderPrompt({
    templatePath,
    agentId: "visual-m2-7",
    role: "visual",
    task: "M2.7",
    ownership: "game/presentation",
  });
  const expected = template
    .replaceAll("<AGENT_ID>", "visual-m2-7")
    .replaceAll("<ROLE>", "visual")
    .replaceAll("<TASK>", "M2.7")
    .replaceAll("<OWNERSHIP>", "game/presentation");
  assert.equal(rendered, expected);
});
```

Assert the rendered prompt contains all eight polling checkpoints, refuses work after failed register/watcher startup, requires peer acknowledgement before shared-contract edits, requires replies and acknowledgements for action/blocker messages, and requires handoff plus close even when blocked.

- [ ] **Step 2: Run prompt tests and capture the RED**

Run: `node --test tests/tools/agent_comms/prompt.test.mjs`

Expected: exit `1` because template and renderer do not exist.

- [ ] **Step 3: Write the canonical prompt and operational guide**

The prompt must tell an agent to execute this lifecycle with its substituted values:

```bash
node tools/agents/comms.mjs init
node tools/agents/comms.mjs register --id <AGENT_ID> --role <ROLE> --task <TASK> --ownership <OWNERSHIP>
node tools/agents/comms.mjs inbox --id <AGENT_ID>
node tools/agents/comms.mjs watch --id <AGENT_ID>
```

It explicitly says the blocking watcher runs in a dedicated long-lived terminal/process whose output remains visible to the agent. It then states the checkpoint polls, the host limitation that watcher output may not interrupt an active reasoning turn, claim-before-edit rule, `reply`/`ack` distinction, handoff evidence requirements, and orderly watcher stop followed by `close`.

`docs/AGENT_COMMS.md` must document discovery, lifecycle, every CLI command, message states, status categories, claims, handoffs, stable exit codes, plaintext/security boundary, stale thresholds, corruption/repair behavior, host push limitation, and the separate-CI rollout.

- [ ] **Step 4: Implement literal template rendering and wire `prompt`**

```js
export async function renderPrompt(input) {
  const template = await readFile(input.templatePath, "utf8");
  return template
    .replaceAll("<AGENT_ID>", input.agentId)
    .replaceAll("<ROLE>", input.role)
    .replaceAll("<TASK>", input.task)
    .replaceAll("<OWNERSHIP>", input.ownership);
}
```

Reject values containing a NUL byte. Validate the id with the shared schema. Keep the template as the sole source of prompt prose.

Add `prompt: runPrompt` to the executable's command map and add a black-box case proving stdout equals `renderPrompt()` exactly and stderr is empty.

- [ ] **Step 5: Add mandatory bootstrap to `AGENTS.md` and ignore runtime state**

Add an early section named `Локальний протокол зв'язку агентів` that requires reading `docs/AGENT_COMMS.md`, generating or following the canonical prompt, registering, polling at the documented checkpoints, respecting claims, and closing presence. State that inability to start the protocol is a blocker for local parallel-agent work, but does not apply to a solitary read-only session.

Add exactly this ignore entry near other project-local state:

```gitignore
# Спільна локальна mailbox-шина агентів; transport state ніколи не комітиться.
.agents/
```

- [ ] **Step 6: Run prompt and documentation contract tests GREEN**

Run: `node --test tests/tools/agent_comms/prompt.test.mjs tests/tools/agent_comms/integration.test.mjs`

Expected: prompt is byte-for-byte derived from the committed template, bootstrap checkpoints are present, CLI command passes, exit `0`.

- [ ] **Step 7: Prove `.agents/` is ignored from main and linked worktree contexts**

Run from the task worktree:

```bash
git check-ignore -v ../../.agents/protocol.json
git status --short
```

Run from the main checkout:

```bash
git check-ignore -v .agents/protocol.json
git status --short
```

Expected: both paths resolve to the new `.agents/` rule; runtime records do not appear in status. Existing unrelated status in main must be reported, not changed.

- [ ] **Step 8: Commit prompt, docs, and bootstrap**

```bash
git add tools/agents/lib/prompt.mjs tools/agents/comms.mjs tests/tools/agent_comms/prompt.test.mjs docs/AGENT_COMMS.md docs/AGENT_COMMS_PROMPT.md AGENTS.md .gitignore
git commit -m "docs: require local agent communication"
```

---
