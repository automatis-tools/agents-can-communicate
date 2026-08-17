import { homedir } from "node:os";
import path from "node:path";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";
import { applyPlan, detectInstallation, planInstallation }
  from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { platformPaths } from "./platform-paths.mjs";

// Where each client keeps its own configuration. All of it derives from one
// home, so a test - or an operator with a second account - can point the whole
// installation somewhere else in one move.
// Each client keeps its own directory under the user's home, and an adapter
// pointed at the home itself writes beside them rather than inside them. That
// install reports success and the client never reads a byte of it.
export const clientContext = home => ({
  home,
  configDir: path.join(home, ".claude"),
  agentsHome: home,
  codexHome: path.join(home, ".codex"),
  kimiHome: path.join(home, ".kimi-code"),
});

export const ALL_ADAPTERS = () => [createClaudeCodeAdapter(), createCodexAdapter(),
  createGeminiCliAdapter(), createKimiAdapter()];

function selectAdapters(requested) {
  const all = ALL_ADAPTERS();
  if (requested === undefined) return all;
  const wanted = Array.isArray(requested) ? requested : [requested];
  const known = new Map(all.map(adapter => [adapter.id, adapter]));
  return wanted.map(id => {
    const adapter = known.get(id);
    if (adapter === undefined) {
      throw new AccError(EXIT.USAGE, `unknown adapter: ${id}`,
        { adapter: id, known: [...known.keys()] });
    }
    return adapter;
  });
}

/**
 * `acc install`, `acc install --dry-run`, and `acc uninstall`.
 *
 * Detection, planning and application are three separate steps on purpose:
 * detection only reads, the plan is deterministic JSON that says exactly what
 * would change, and application is the only step that writes. `--dry-run` shows
 * the plan and stops - so what an operator approves is the same object that is
 * then carried out, not a description of it produced somewhere else.
 */
export async function runInstallCommand({ options, runtime, action = "install" }) {
  const adapters = selectAdapters(options.adapter);
  const home = options.home ?? runtime.env?.HOME ?? homedir();
  const context = clientContext(home);
  const { data: dataHome } = platformPaths({ platform: runtime.platform,
    env: runtime.env ?? {} });

  const detected = await detectInstallation({ adapters, context });
  const plan = planInstallation({ adapters, detected, context, action });

  const dryRun = options.dryRun === true;
  const result = await applyPlan({ plan, adapters, context, dataHome, dryRun });

  const acted = result.operations.filter(operation => operation.applied).length;
  const text = dryRun
    ? [`would ${action}:`, ...plan.operations.flatMap(operation => operation.summary),
      ...plan.skipped.map(entry => `skip ${entry.adapterId}: ${entry.reason}`)].join("\n")
    : `${action}ed ${acted} adapter(s)`
      + (result.failed.length > 0 ? `; ${result.failed.length} failed` : "");

  return { data: { ...result, plan, dataHome }, text };
}
