// The headless form of each client the context-token measurement runs (#135),
// and how each one reports the input tokens of a prompt. Every client counts
// with its own tokenizer, so the same ACC text costs a different number of
// tokens in each. A parser returns the input tokens of the first model request,
// the number of requests and tool calls, the model and its context window.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** The most recently written file under `root` whose name ends with `name`. */
async function newest(root, name) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const { mtimeMs } = await stat(file);
    if (best === null || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
  }
  return best?.file ?? null;
}

const jsonLines = text => text.split("\n").filter(line => line.startsWith("{"))
  .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

export function parseClaude(stdout) {
  const result = JSON.parse(stdout);
  const iterations = result.usage?.iterations ?? [result.usage];
  const first = iterations[0];
  const [model, usage] = Object.entries(result.modelUsage ?? {})[0] ?? [null, {}];
  return { inputTokens: first.input_tokens + (first.cache_read_input_tokens ?? 0)
    + (first.cache_creation_input_tokens ?? 0), requests: iterations.length,
  toolCalls: result.num_turns > 1 ? result.num_turns - 1 : 0, model,
  contextWindow: usage.contextWindow ?? null, reply: result.result };
}

// Codex sums a turn's requests; the rollout names the model and its window.
export function parseCodex(stdout, rollout = "") {
  const events = jsonLines(stdout);
  const usage = events.find(event => event.type === "turn.completed")?.usage;
  if (usage === undefined) throw new Error(`codex reported no usage: ${stdout.slice(-400)}`);
  const items = events.filter(event => event.type === "item.completed").map(event => event.item);
  const records = jsonLines(rollout);
  const window = records.map(record => record.payload?.info?.model_context_window).filter(Boolean).at(-1);
  return { inputTokens: usage.input_tokens, requests: null,
    // An `error` item is Codex's own warning, such as the hook-trust bypass notice.
    toolCalls: items.filter(item => !["agent_message", "reasoning", "error"].includes(item.type)).length,
    model: records.find(record => record.type === "turn_context")?.payload?.model ?? null,
    contextWindow: window ?? null,
    reply: items.filter(item => item.type === "agent_message").map(item => item.text).join("\n") };
}

// Gemini CLI routes some requests to a utility model; only the main role is the session.
export function parseGemini(stdout) {
  const result = JSON.parse(stdout.slice(stdout.search(/^\{/m)));
  const main = Object.entries(result.stats?.models ?? {})
    .filter(([, stats]) => (stats.roles === undefined || "main" in stats.roles) && stats.tokens.prompt > 0);
  if (main.length !== 1) throw new Error(`gemini main model is not one: ${JSON.stringify(result.stats)}`);
  const [[model, stats]] = main;
  const requests = stats.api.totalRequests - stats.api.totalErrors;
  return { inputTokens: requests === 1 ? stats.tokens.prompt : null, requests,
    toolCalls: Object.values(result.stats?.tools?.byName ?? {}).reduce((sum, tool) => sum + tool.count, 0),
    // Gemini CLI reports no window; every Gemini 3 model accepts 1,048,576 input tokens.
    model, contextWindow: 1_048_576, reply: result.response };
}

// Kimi's stream has no usage; its session log records every request of every turn.
export function parseKimi(wire, config = "") {
  const all = jsonLines(wire);
  const start = all.findLastIndex(event => event.type === "agent.turn.started");
  const events = all.slice(Math.max(0, start));
  const usage = events.find(event => event.type === "usage.record")?.usage;
  if (usage === undefined) throw new Error("kimi recorded no usage");
  const requests = events.filter(event => event.type === "llm.request");
  const alias = requests[0]?.modelAlias ?? null;
  const section = alias === null ? "" : config.split(/^(?=\[)/m)
    .find(block => block.startsWith(`[models."${alias}"]`)) ?? "";
  const window = /^max_context_size\s*=\s*(\d+)/m.exec(section)?.[1];
  return { inputTokens: requests.length === 1
    ? usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation : null,
  requests: requests.length, toolCalls: events.filter(event => event.type === "tool.call").length,
  model: alias, contextWindow: window === undefined ? null : Number(window), reply: null };
}

export const CLIENTS = Object.freeze({
  claude_code: {
    binary: "claude",
    // No tools and no MCP servers: an account's claude.ai connectors arrive in some
    // sessions and not others and add tens of thousands of tokens of tool schemas.
    args: (prompt, resume, model) => ["-p", prompt, "--output-format", "json", "--tools", "",
      "--strict-mcp-config", ...(model ? ["--model", model] : []), ...(resume ? ["--continue"] : [])],
    read: async ({ stdout }) => parseClaude(stdout),
  },
  codex: {
    binary: "codex", env: home => ({ CODEX_HOME: path.join(home, ".codex") }),
    // Codex runs a plugin's hooks only once a user trusted them in its TUI. The
    // measurement installed these hooks itself, so it runs them without that record.
    // An account's remote plugins arrive after the first run and list dozens of
    // skills; they are left out so that only ACC differs between runs.
    args: (prompt, resume, model) => ["--dangerously-bypass-hook-trust", "-c", "features.remote_plugin=false",
      ...(model ? ["-m", model] : []), "exec", "--skip-git-repo-check",
      "--json", "-s", "read-only",
      ...(resume ? ["resume", "--last"] : []), prompt],
    read: async ({ stdout, home }) => {
      const rollout = await newest(path.join(home, ".codex", "sessions"), ".jsonl");
      return parseCodex(stdout, rollout === null ? "" : await readFile(rollout, "utf8"));
    },
  },
  gemini_cli: {
    binary: "gemini", env: () => ({ GEMINI_CLI_TRUST_WORKSPACE: "true" }),
    // One model for every run: the default router changes model when one is busy.
    defaultModel: "gemini-3.6-flash",
    args: (prompt, resume, model) => ["--skip-trust", "-p", prompt, "-o", "json", "--approval-mode", "plan",
      "-m", model, ...(resume ? ["--resume", "latest"] : [])],
    read: async ({ stdout }) => parseGemini(stdout),
  },
  kimi: {
    binary: "kimi",
    args: (prompt, resume, model) => ["-p", prompt, "--output-format", "stream-json",
      ...(model ? ["--model", model] : []), ...(resume ? ["--continue"] : [])],
    read: async ({ home }) => {
      const wire = await newest(path.join(home, ".kimi-code", "sessions"), "wire.jsonl");
      if (wire === null) throw new Error("kimi wrote no session log");
      const config = await readFile(path.join(home, ".kimi-code", "config.toml"), "utf8").catch(() => "");
      return parseKimi(await readFile(wire, "utf8"), config);
    },
  },
});
