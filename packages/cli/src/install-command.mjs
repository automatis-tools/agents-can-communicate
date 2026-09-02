import { homedir } from "node:os";
import path from "node:path";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";
import { LIVE_POLICIES, applyPlan, describeActivation, detectInstallation, livePolicyOf,
  loadOwnership, planInstallation, rcFileFor, shellOf, shimDirFor }
  from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { platformPaths } from "./platform-paths.mjs";

// Where each client keeps its own configuration. All of it derives from one
// home, so a test - or an operator with a second account - can point the whole
// installation somewhere else in one move.
// Each client keeps its own directory under the user's home, and an adapter
// pointed at the home itself writes beside them rather than inside them. That
// install reports success and the client never reads a byte of it.
export const clientContext = (home, stateRoot, { shell = null, env = {} } = {}) => ({
  home,
  configDir: path.join(home, ".claude"),
  agentsHome: home,
  codexHome: path.join(home, ".codex"),
  kimiHome: path.join(home, ".kimi-code"),
  grokHome: path.join(home, ".grok"),
  // The user's login shell and PATH, for the optional native shell bootstrap:
  // which rc file could carry an ACC PATH block and which real executable a
  // shim would exec. Detection reads them; nothing here writes.
  shell,
  env,
  // Where ACC keeps its own state, for the client that has to be told. Codex
  // sandboxes the commands a model runs to the workspace, and ACC's state is
  // outside every workspace on purpose - so an agent there could read the
  // roster and record nothing, every write failing with EPERM on the writer
  // lock. Measured with `codex exec`, which is how an agent actually runs.
  stateRoot,
});

export const ALL_ADAPTERS = () => [createClaudeCodeAdapter(), createCodexAdapter(),
  createGeminiCliAdapter(), createGrokAdapter(), createKimiAdapter()];

/**
 * How long to wait for a client to say its version.
 *
 * Detection spawns the client's own binary, and three seconds is generous on an
 * idle machine and not always enough on a busy one: a cold start that overruns
 * it makes an installed client look absent, and the installer skips it saying so
 * in as many words. Raising it is for the machine that needs it - a loaded CI
 * runner, a slow disk - rather than a default nobody can change.
 */
export function probeTimeout(env) {
  const asked = Number.parseInt(env?.ACC_PROBE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(asked) && asked > 0 ? asked : undefined;
}

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
    ...(operation.removedDirectories ?? [])
      .map(file => `  removed ${shorten(file, home)}`),
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
  ...operations.filter(operation => operation.applied
    && typeof operation.deliveryDiagnostic === "string")
    .map(operation => `  ${operation.deliveryDiagnostic}`),
  ...skipped.map(entry => `  skip ${entry.adapterId}: ${entry.reason}`),
  ...failed.map(entry => `  ${entry.adapterId}: ${entry.error}`),
  // Said once, where it is needed: the reader has just been shown a list of
  // their own files with ACC's name in them.
  ...(action === "install" && acted > 0 ? ["", "undo with: acc uninstall"] : []),
  // And said once where it is needed differently: an install that wired nothing
  // has just told this reader four times that their machine is not supported.
  // It is not - the MCP server needs no adapter, and was measured answering on a
  // machine with no client binaries at all. Only when nothing was wired: the
  // skips already carry their own remedy, and a line printed every time is a
  // line that stops being read.
  ...(action === "install" && acted === 0
    ? ["", "no client was wired, but any MCP client can still take part: "
      + "point it at the acc-mcp command"]
    : []),
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
      || (operation.removed?.length ?? 0) + (operation.removedDirectories?.length ?? 0)
        + (operation.changes?.length ?? 0) > 0)).length;
}

const isInteractive = runtime => typeof runtime.isInteractive === "function"
  && runtime.isInteractive() === true;

// One default-No question per eligible client, asked only after detection has
// finished and only when a person is at both ends of the terminal. It names
// the client, the mechanism, and the files or service it would touch, and says
// when the choice takes effect.
function questionFor(entry, context) {
  const activation = { livePolicy: "actionable", shell: context.shell,
    rcFile: rcFileFor(context.home, context.shell), shimDir: shimDirFor(context.stateRoot),
    mechanisms: entry.nativeDelivery.activationPlan.mechanisms };
  return [`Enable native live delivery for ${entry.displayName} ${entry.version}?`,
    ...describeActivation(activation).map(line => `  ${line}`),
    "  applies to newly started sessions; a new PATH block needs a new or reloaded shell"]
    .join("\n");
}

/**
 * Which live policy each selected client gets.
 *
 * An explicit --delivery applies uniformly and never prompts. Otherwise a
 * recorded opt-in is kept as it was consented to, a fresh or never-activated
 * client is off unless a person answers yes here, and a dry run or a
 * non-interactive stdin/stdout makes no interactive choice at all.
 */
export async function decideDelivery({ options, detected, recorded, runtime, dryRun, context }) {
  const explicit = options.delivery;
  if (explicit !== undefined && !LIVE_POLICIES.includes(explicit)) {
    throw new AccError(EXIT.USAGE, `unknown delivery policy: ${explicit}`, { delivery: explicit });
  }
  const recordedById = new Map(recorded.map(install => [install.adapterId, install]));
  const deliveryByAdapter = {};
  const asked = [];
  let withheld = 0;
  for (const entry of detected) {
    const eligible = entry.nativeDelivery?.state === "eligible";
    const previous = livePolicyOf(recordedById.get(entry.adapterId));
    if (explicit !== undefined) {
      deliveryByAdapter[entry.adapterId] = explicit;
    } else if (previous !== "off") {
      deliveryByAdapter[entry.adapterId] = previous;
    } else if (!eligible || dryRun || !isInteractive(runtime)) {
      deliveryByAdapter[entry.adapterId] = "off";
      if (eligible) withheld += 1;
    } else {
      const yes = await runtime.confirm(questionFor(entry, context),
        { input: runtime.input, output: runtime.output }) === true;
      deliveryByAdapter[entry.adapterId] = yes ? "actionable" : "off";
      asked.push(entry.adapterId);
    }
  }
  const notes = explicit === undefined && dryRun && withheld > 0
    ? ["interactive choices were not made: this preview keeps native delivery off for "
      + `${withheld} eligible client(s) without a recorded opt-in`]
    : [];
  return { deliveryByAdapter, asked, notes };
}

// Said once, after the first PATH block is written: a running shell and a
// running client know nothing about it.
function reloadAdvice(operations) {
  const appended = operations.filter(operation => operation.appendedRcBlock === true);
  if (appended.length === 0) return [];
  const rc = appended[0].nativeActivation?.rcFile ?? "your shell rc file";
  return ["", `native delivery is wired for new sessions: open a new terminal (or reload ${rc}), `
    + "then start the client normally; a session already running keeps durable delivery"];
}

export async function runInstallCommand({ options, runtime, action = "install" }) {
  const adapters = selectAdapters(options.adapter);
  const home = options.home ?? runtime.env?.HOME ?? homedir();
  const { data: dataHome } = platformPaths({ platform: runtime.platform,
    env: runtime.env ?? {} });
  const context = clientContext(home, path.join(dataHome, "acc"),
    { shell: shellOf(runtime.env), env: runtime.env ?? {} });

  const detected = await detectInstallation({ adapters, context,
    probeTimeoutMs: probeTimeout(runtime.env) });
  // An uninstall is planned from what ACC recorded writing, not only from what
  // is on the machine now. A client can be removed after ACC installed into it,
  // and its configuration directory - with ACC's files in it - stays behind.
  // Read on both actions now. An uninstall plans from it because a client can
  // leave the machine after ACC wrote to it; an install reads it to see which
  // ACC is already wired, so an older copy cannot replace a newer one in
  // silence.
  const recorded = (await loadOwnership({ dataHome })).installs;

  const dryRun = options.dryRun === true;
  // Recorded with the install, so a later run can tell that the bundle sitting
  // in a client is older than the code now running. Updating the npm package
  // replaces this CLI and the hook runtime and leaves that bundle untouched.
  const accVersion = typeof runtime.version === "function"
    ? await runtime.version().catch(() => null)
    : null;
  // Naming a client is an answer to the question the version probe was guessing
  // at. `acc install --adapter gemini_cli` says the client is here, whatever
  // PATH this process happens to carry.
  const requested = options.adapter === undefined
    ? []
    : (Array.isArray(options.adapter) ? options.adapter : [options.adapter]);
  // Decided only after detection, from the operator's explicit answer, the
  // recorded consent, or a default of off; never from inference.
  const decided = action === "install"
    ? await decideDelivery({ options, detected, recorded, runtime, dryRun, context })
    : { deliveryByAdapter: {}, asked: [], notes: [] };
  const plan = planInstallation({ adapters, detected, context, action, recorded,
    accVersion, allowDowngrade: options.downgrade === true, requested,
    deliveryByAdapter: decided.deliveryByAdapter });
  const result = await applyPlan({ plan, adapters, context, dataHome, dryRun, accVersion });

  const acted = actedOn(result);
  if (dryRun) {
    return { data: { ...result, plan, dataHome, deliveryByAdapter: decided.deliveryByAdapter },
      text: [`would ${action}:`, ...plan.operations.flatMap(operation => operation.summary),
        ...plan.skipped.map(entry => `skip ${entry.adapterId}: ${entry.reason}`),
        ...decided.notes].join("\n") };
  }

  return { data: { ...result, plan, dataHome, deliveryByAdapter: decided.deliveryByAdapter,
    asked: decided.asked },
  text: [describeOutcome({ action, acted, failed: result.failed,
    skipped: plan.skipped, operations: result.operations, home }),
  ...reloadAdvice(result.operations)].join("\n"),
  error: failureOf({ action, acted, failed: result.failed }) };
}
