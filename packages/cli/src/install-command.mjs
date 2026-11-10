import { homedir } from "node:os";
import path from "node:path";

import { createAntigravityAdapter } from "@agents-can-communicate/adapter-antigravity";
import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";
import { applyPlan, detectInstallation, livePolicyOf, loadOwnership, planInstallation,
  receiverLoopback, receiverSockets } from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { platformPaths } from "./platform-paths.mjs";
import { installManaged, uninstallManaged } from "./managed-runtime/install.mjs";
import { decideDelivery, deliveryNotes } from "./install-delivery-consent.mjs";

export { decideDelivery } from "./install-delivery-consent.mjs";

// Kept cohesive above 300 lines because this is the install command boundary:
// detection, consent, planning, application, and reporting share one context
// and result contract that would otherwise be duplicated across modules.

// Where each client keeps its own configuration. All of it derives from one
// home, so a test - or an operator with a second account - can point the whole
// installation somewhere else in one move.
// Each client keeps its own directory under the user's home, and an adapter
// pointed at the home itself writes beside them rather than inside them. That
// install reports success and the client never reads a byte of it.
// Each client also honours its own relocation variable, and none reads
// XDG_CONFIG_HOME (measured 2026-11-01, #148): Claude Code 2.1.316
// CLAUDE_CONFIG_DIR, Codex 0.166.0 CODEX_HOME, Gemini CLI 0.60.0 GEMINI_CLI_HOME
// (the parent of .gemini), Kimi Code 2.4.1 KIMI_CODE_HOME and Grok 1.0.70
// GROK_HOME. Antigravity CLI 1.4.12 has none. An integration written beside the
// client's real directory is one the client never reads.
const absoluteEnv = (env, name) => typeof env[name] === "string" && path.isAbsolute(env[name])
  ? env[name] : null;
// The directory each client reads its configuration from, as install resolved
// it, and the variable that moved it there (null at the default). Doctor reports
// both, so an integration written for another location is visible.
const RELOCATION = { claude_code: ["configDir", "CLAUDE_CONFIG_DIR"], codex: ["codexHome", "CODEX_HOME"],
  kimi: ["kimiHome", "KIMI_CODE_HOME"], grok: ["grokHome", "GROK_HOME"] };
export function clientConfigHome(context, adapterId, env = {}) {
  if (adapterId === "gemini_cli") {
    return { path: path.join(context.geminiHome ?? context.home, ".gemini"),
      variable: context.geminiHome && context.geminiHome !== context.home ? "GEMINI_CLI_HOME" : null };
  }
  if (adapterId === "antigravity") return { path: path.join(context.home, ".gemini"), variable: null };
  const [key, variable] = RELOCATION[adapterId] ?? [];
  if (key === undefined) return null;
  return { path: context[key], variable: typeof env[variable] === "string" && env[variable] === context[key]
    ? variable : null };
}
export const clientContext = (home, stateRoot,
  { env = {}, dataHome, cwd = process.cwd(), platform, livePolicies = {} } = {}) => withReceivers({
  home,
  // Each client's recorded live-delivery policy. A receiver's loopback
  // declaration depends on it: a grant for a listener nobody enabled is a hole.
  livePolicies,
  ...(dataHome === undefined ? {} : { dataHome }),
  configDir: absoluteEnv(env, "CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude"),
  agentsHome: home,
  codexHome: typeof env.CODEX_HOME === "string" && env.CODEX_HOME !== ""
    ? env.CODEX_HOME : path.join(home, ".codex"),
  geminiHome: absoluteEnv(env, "GEMINI_CLI_HOME") ?? home,
  kimiHome: absoluteEnv(env, "KIMI_CODE_HOME") ?? path.join(home, ".kimi-code"),
  // Every directory a client reads, for directories ACC creates outside the
  // home when a variable moved one there.
  clientRoots: [absoluteEnv(env, "CLAUDE_CONFIG_DIR"), env.CODEX_HOME || null, absoluteEnv(env, "GEMINI_CLI_HOME"),
    absoluteEnv(env, "KIMI_CODE_HOME"), env.GROK_HOME || null].filter(Boolean),
  grokHome: typeof env.GROK_HOME === "string" && env.GROK_HOME !== ""
    ? env.GROK_HOME : path.join(home, ".grok"),
  // The user's PATH, for finding the real client executable to probe.
  // Detection reads it; nothing here writes.
  env,
  // Antigravity CLI keeps its hooks in the `~/.gemini` tree Gemini CLI also
  // uses, and reads none of the same files. Two locations load - the
  // machine-wide `~/.gemini/config/hooks.json` and a project's own
  // `.agents/hooks.json`, the second only while that project is an open
  // workspace. Global is the default (issue #178), because a workspace
  // registration in a folder nobody opened as one registers nothing and says
  // nothing. ACC_ANTIGRAVITY_HOOKS is carried through exactly as it was set,
  // wrong values included, so the adapter can refuse one by name rather than
  // quietly installing somewhere else.
  antigravityWorkspace: cwd,
  antigravityHookLocation: typeof env.ACC_ANTIGRAVITY_HOOKS === "string"
    && env.ACC_ANTIGRAVITY_HOOKS !== "" ? env.ACC_ANTIGRAVITY_HOOKS : "global",
  // Where ACC keeps its own state, for the client that has to be told. Codex
  // sandboxes the commands a model runs to the workspace, and ACC's state is
  // outside every workspace on purpose - so an agent there could read the
  // roster and record nothing, every write failing with EPERM on the writer
  // lock. Measured with `codex exec`, which is how an agent actually runs.
  stateRoot,
}, platform);

// Every socket ACC can deliver to, as each receiving adapter declares it, for
// the one sender that sandboxes its shell: the Codex permission profile is
// written and diagnosed from this list, so it covers Claude Code's inbox even
// when an install names Codex alone (issue #213). A declared loopback receiver
// composes the same way (issue #390): any adapter's inboundLoopback allows the
// exact 127.0.0.1 literal in the sender's profile, and nothing broader. Unlike
// a socket path, that literal opens every local port, so a receiver declares
// it only while its own live delivery is enabled in `context.livePolicies`.
const withReceivers = (context, platform) => ({ ...context,
  receiverSockets: receiverSockets(ALL_ADAPTERS(), { ...context, platform }),
  receiverLoopback: receiverLoopback(ALL_ADAPTERS(), { ...context, platform }) });

export const ALL_ADAPTERS = () => [createAntigravityAdapter(), createClaudeCodeAdapter(),
  createCodexAdapter(), createGeminiCliAdapter(), createGrokAdapter(), createKimiAdapter()];

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
  // An uninstall's merge edits come from the plan - every file ACC has ever
  // written into - while everything else on this list is decided by the run.
  // Printed unconditionally, a second uninstall told the operator it had edited
  // six of their configuration files whose bytes it had not touched. `changes`
  // is what the adapter actually took out, and is already what the packed
  // verifier calls a no-op, so the report now follows the same definition. It
  // is still the plan's list rather than a per-file one: this says whether
  // anything was edited, not which of several files it was.
  const editedIfAnything = (operation.changes ?? []).length === 0 ? [] : edited;
  return [
    ...(operation.removed ?? []).map(file => `  removed ${shorten(file, home)}`),
    ...(operation.removedDirectories ?? [])
      .map(file => `  removed ${shorten(file, home)}`),
    ...editedIfAnything,
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
    && typeof (operation.deliverySummary ?? operation.deliveryDiagnostic) === "string")
    .map(operation => `  ${operation.deliverySummary ?? operation.deliveryDiagnostic}`),
  ...operations.filter(operation => operation.applied)
    .flatMap(operation => (operation.needsAction ?? [])
      .map(step => `  ${operation.adapterId}: ${step}`)),
  ...operations.filter(operation => operation.applied)
    .flatMap(operation => (operation.setupNotes ?? []).map(note => `  ${note}`)),
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
export function failureOf({ action, acted, failed = [], operations = [], skipped = [], home }) {
  if (failed.length === 0) return null;
  return new AccError(EXIT.DATA,
    describeOutcome({ action, acted, failed, operations, skipped, home }), { failed });
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

// Each client's live policy as it is actually activated: the recorded native
// activation, not the requested policy. A Kimi below the Web floor records the
// request and activates nothing, and declares no listener either.
const activated = policy => ["actionable", "all"].includes(policy) ? policy : "off";
export const recordedLivePolicies = recorded => Object.fromEntries(recorded
  .map(install => [install.adapterId, livePolicyOf(install) === "off" ? "off"
    : activated(install.nativeActivation?.livePolicy)]));
// The same, for what one planned operation leaves behind.
export const plannedLivePolicy = operation => operation.action !== "install" ? "off"
  : activated(operation.nativeActivation?.livePolicy
    ?? operation.retainedNativeActivation?.livePolicy);

/**
 * A receiver's live policy changes the sender grants Codex needs: Kimi Web's
 * loopback listener is declared only while Kimi's live delivery is activated.
 * The run's own plan says which clients it actually changes - a client that is
 * absent, blocked or downgrade-guarded is skipped and keeps its record - and an
 * uninstall takes each client it removes to off. The returned context carries
 * the policies this run leaves, so a sender inside the run is written for them.
 */
function followReceivers({ adapters, detected, decided, recorded, home, dataHome, runtime,
  planWith }) {
  const build = livePolicies => clientContext(home, path.join(dataHome, "acc"),
    { env: runtime.env ?? {}, dataHome, platform: runtime.platform, livePolicies });
  const before = recordedLivePolicies(recorded);
  const preliminary = planWith({ adapters, detected, context: build(before),
    deliveryByAdapter: decided.deliveryByAdapter,
    deliveryDecisionByAdapter: decided.deliveryDecisionByAdapter });
  const after = { ...before };
  for (const operation of preliminary.operations) after[operation.adapterId] = plannedLivePolicy(operation);
  return { context: build(after), loopbackChanged: build(before).receiverLoopback
    !== build(after).receiverLoopback };
}

/**
 * When the run flips the loopback declaration and an installed sandboxed sender
 * is not part of it, that sender's own grants are brought up to date in the same
 * command - the 127.0.0.1 grant added when Kimi's live delivery comes on, and
 * removed when it goes off or Kimi is uninstalled. Only the sender's owned
 * permission units change; its integration, record and service stay as they are.
 */
async function refreshSenders({ adapters, recorded, context, dryRun }) {
  const named = new Set(adapters.map(adapter => adapter.id));
  const results = [];
  for (const sender of ALL_ADAPTERS()) {
    const record = recorded.find(install => install.adapterId === sender.id);
    if (typeof sender.refreshSenderPermissions !== "function" || record === undefined
      || named.has(sender.id)) continue;
    try {
      const result = await sender.refreshSenderPermissions({ ...context,
        requestedLivePolicy: livePolicyOf(record),
        livePolicy: activated(record.nativeActivation?.livePolicy),
        clientVersion: record.version ?? null, dryRun });
      results.push({ adapterId: sender.id, ...result });
    } catch (error) {
      results.push({ adapterId: sender.id, changed: false, error: error.message });
    }
  }
  return results;
}

const describeSenders = (senders, dryRun) => senders.flatMap(sender =>
  sender.error !== undefined
    ? [`${sender.adapterId}: sender permissions not updated (${sender.error}); run acc install --adapter ${sender.adapterId}`]
    : sender.changed ? [`${sender.adapterId}: ${dryRun ? "would update" : "updated"} sender permissions `
      + `for the changed loopback receiver in ${sender.file}`] : []);

export async function runInstallCommand({ options, runtime, action = "install" }) {
  if (options.indicator !== undefined && !["on", "off"].includes(options.indicator)) {
    throw new AccError(EXIT.USAGE, "--indicator must be on or off");
  }
  const adapters = selectAdapters(options.adapter);
  const home = options.home ?? runtime.env?.HOME ?? homedir();
  const { data: dataHome } = platformPaths({ platform: runtime.platform,
    env: runtime.env ?? {} });
  const context = clientContext(home, path.join(dataHome, "acc"),
    { env: runtime.env ?? {}, dataHome, platform: runtime.platform });

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
  // Decided only after detection: the operator's explicit option, otherwise the
  // default, which turns delivery on and leaves a person's own off alone.
  const decided = action === "install"
    ? decideDelivery({ options, detected, recorded, dryRun })
    : { deliveryByAdapter: {}, turnedOn: [], notes: [] };
  const planWith = input => planInstallation({ ...input, action, recorded,
    indicator: options.indicator,
    accVersion, allowDowngrade: options.downgrade === true, requested,
    allowServiceSetup: action === "install" });
  // The receivers this run leaves activated decide the sender grants it writes.
  const following = followReceivers({ adapters, detected, decided, recorded,
    home, dataHome, runtime, planWith });
  const plan = planWith({ adapters, detected, context: following.context,
    deliveryByAdapter: decided.deliveryByAdapter,
    deliveryDecisionByAdapter: decided.deliveryDecisionByAdapter });
  const apply = (paths = {}) => applyPlan({ plan, adapters,
    context: { ...following.context, ...paths }, dataHome, dryRun, accVersion });
  const result = action === "install" && !dryRun && runtime.packageRoot
    ? await installManaged({ packageRoot: runtime.packageRoot,
      managerRoot: path.join(dataHome, "acc", "runtime"), dataHome, home, cwd: options.cwd ?? runtime.cwd,
      targets: plan.operations.map(operation => operation.adapterId), env: runtime.env, apply })
    : action === "uninstall" && !dryRun && runtime.managerRoot
      ? await uninstallManaged({ managerRoot: runtime.managerRoot, apply })
      : await apply();

  const acted = actedOn(result);
  // Judged from what the run actually recorded, so a client that failed to
  // install or uninstall leaves the senders as they were.
  const left = dryRun ? recorded : (await loadOwnership({ dataHome })).installs;
  const leftContext = dryRun ? following.context : clientContext(home, path.join(dataHome, "acc"),
    { env: runtime.env ?? {}, dataHome, platform: runtime.platform,
      livePolicies: recordedLivePolicies(left) });
  const loopbackBefore = clientContext(home, path.join(dataHome, "acc"),
    { env: runtime.env ?? {}, dataHome, platform: runtime.platform,
      livePolicies: recordedLivePolicies(recorded) }).receiverLoopback;
  const senders = (dryRun ? following.loopbackChanged : leftContext.receiverLoopback !== loopbackBefore)
    ? await refreshSenders({ adapters, recorded: left, context: leftContext, dryRun }) : [];
  if (dryRun) {
    return { data: { ...result, plan, dataHome, deliveryByAdapter: decided.deliveryByAdapter,
      deliveryDecisionByAdapter: decided.deliveryDecisionByAdapter, senders },
      text: [`would ${action}:`, ...plan.operations.flatMap(operation => operation.summary),
        ...plan.skipped.map(entry => `skip ${entry.adapterId}: ${entry.reason}`),
        ...describeSenders(senders, true), ...decided.notes].join("\n") };
  }

  // Announced from what this run applied: a client that failed keeps its old policy.
  const failedIds = new Set((result.failed ?? []).map(failure => failure.adapterId));
  const turnedOn = decided.turnedOn.filter(entry => !failedIds.has(entry.adapterId));
  return { data: { ...result, plan, dataHome, deliveryByAdapter: decided.deliveryByAdapter,
    deliveryDecisionByAdapter: decided.deliveryDecisionByAdapter, senders },
  text: [describeOutcome({ action, acted, failed: result.failed,
    skipped: plan.skipped, operations: result.operations, home }),
  ...describeSenders(senders, false), ...deliveryNotes(turnedOn, false)]
    .filter(line => line !== "").join("\n"),
  error: failureOf({ action, acted, failed: result.failed, operations: result.operations,
    skipped: plan.skipped, home }) };
}
