import { homedir } from "node:os";
import path from "node:path";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";
import { applyPlan, detectInstallation, loadOwnership, planInstallation }
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
/**
 * What the command says it did.
 *
 * `installed 0 adapter(s)` was the whole report whether four clients were
 * absent, one refused, or nothing was asked for. The reasons existed - the plan
 * carries one per skipped adapter and the result one per failure - and only
 * `--json` ever showed them.
 */
const shorten = (file, home) =>
  typeof home === "string" && home !== "" && file.startsWith(`${home}/`)
    ? `~${file.slice(home.length)}`
    : file;

/**
 * What one adapter did, path by path.
 *
 * `installed 3 adapter(s)` was the whole account of a command that had just
 * written into three other tools' configuration inside someone's home. The list
 * existed all along - it is what `--dry-run` prints - and the run that actually
 * did the work printed a number.
 *
 * An install says what it wrote from the plan it carried out, in the same words
 * the preview uses. An uninstall says what was removed and what was held back,
 * because those are decided while it runs: bytes that stopped matching what ACC
 * wrote are someone's now, and are kept.
 */
export function describeChanges(operation, home) {
  const artifacts = operation.artifacts ?? [];
  const edited = artifacts.filter(artifact => artifact.kind === "merge")
    .map(artifact => `  edited  ${shorten(artifact.path, home)}`);
  if (operation.action !== "uninstall") {
    return [...artifacts.filter(artifact => artifact.kind !== "merge")
      .map(artifact => `  created ${shorten(artifact.path, home)}`), ...edited];
  }
  return [
    ...(operation.removed ?? []).map(file => `  removed ${shorten(file, home)}`),
    ...edited,
    ...(operation.kept ?? [])
      .map(file => `  kept    ${shorten(file, home)} - changed since ACC wrote it`),
  ];
}

export function describeOutcome({ action, acted, failed = [], skipped = [],
  operations = [], home }) {
  return [`${action}ed ${acted} adapter(s)`
    + (failed.length > 0 ? `; ${failed.length} failed` : ""),
  ...operations.filter(operation => operation.applied)
    .flatMap(operation => describeChanges(operation, home)),
  ...skipped.map(entry => `  skip ${entry.adapterId}: ${entry.reason}`),
  ...failed.map(entry => `  ${entry.adapterId}: ${entry.error}`),
  // Said once, where it is needed: the reader has just been shown a list of
  // their own files with ACC's name in them.
  ...(action === "install" && acted > 0 ? ["", "undo with: acc uninstall"] : []),
  ].join("\n");
}

/**
 * A failed adapter ends the command.
 *
 * It used to be counted in a line that began with a success and exit 0, which is
 * what a malformed `~/.claude/settings.json` produced: the adapter refused,
 * correctly, and the script that ran the installer was told it had worked.
 */
export function failureOf({ action, acted, failed = [] }) {
  if (failed.length === 0) return null;
  return new AccError(EXIT.DATA,
    describeOutcome({ action, acted, failed }), { failed });
}

/**
 * How many adapters this actually did something to.
 *
 * `applied` means the adapter's own step ran, which on an uninstall is true of
 * every client on the machine whether ACC had ever written to it or not. So
 * `uninstalled 3 adapter(s)` was the report on a machine where ACC had installed
 * nothing at all - printed by the same run that skipped the one client it had
 * actually written to.
 */
export function actedOn(result) {
  return result.operations.filter(operation => operation.applied
    && (result.action === "install"
      || (operation.removed?.length ?? 0) + (operation.changes?.length ?? 0) > 0)).length;
}

export async function runInstallCommand({ options, runtime, action = "install" }) {
  const adapters = selectAdapters(options.adapter);
  const home = options.home ?? runtime.env?.HOME ?? homedir();
  const context = clientContext(home);
  const { data: dataHome } = platformPaths({ platform: runtime.platform,
    env: runtime.env ?? {} });

  const detected = await detectInstallation({ adapters, context });
  // An uninstall is planned from what ACC recorded writing, not only from what
  // is on the machine now. A client can be removed after ACC installed into it,
  // and its configuration directory - with ACC's files in it - stays behind.
  const recorded = action === "uninstall"
    ? (await loadOwnership({ dataHome })).installs
    : [];
  const plan = planInstallation({ adapters, detected, context, action, recorded });

  const dryRun = options.dryRun === true;
  const result = await applyPlan({ plan, adapters, context, dataHome, dryRun });

  const acted = actedOn(result);
  if (dryRun) {
    return { data: { ...result, plan, dataHome },
      text: [`would ${action}:`, ...plan.operations.flatMap(operation => operation.summary),
        ...plan.skipped.map(entry => `skip ${entry.adapterId}: ${entry.reason}`)].join("\n") };
  }

  return { data: { ...result, plan, dataHome },
    text: describeOutcome({ action, acted, failed: result.failed,
      skipped: plan.skipped, operations: result.operations, home }),
    error: failureOf({ action, acted, failed: result.failed }) };
}
