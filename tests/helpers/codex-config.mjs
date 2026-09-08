// Synthetic shape from Codex 0.153.4 rewriting a 0.3.1 ACC install. Paths,
// model metadata and hashes are placeholders; these hashes grant no real trust.
export const clientTables = `[projects."/synthetic/project"]
trust_level = "trusted"

[tui.model_availability_nux]
synthetic-model = 1

[hooks.state]

${["pre_tool_use", "session_start", "session_end", "user_prompt_submit", "stop"]
  .map((event, i) => `[hooks.state."agents-can-communicate@acc-local:hooks.json:${event}:0:0"]
trusted_hash = "sha256:${String(i + 1).repeat(64)}"`).join("\n\n")}
`;

export const rewrittenCodexConfig = stateRoot => `model = "synthetic-model"
model_reasoning_effort = "high"

[features]
hooks = true

# >>> agents-can-communicate (managed; edits here are overwritten)
[marketplaces.acc-local]
source_type = "local"
source = "/synthetic/home/.agents/acc-local"

[plugins."agents-can-communicate@acc-local"]
enabled = true

[sandbox_workspace_write]
writable_roots = [${JSON.stringify(stateRoot)}]

${clientTables}# <<< agents-can-communicate
`;
