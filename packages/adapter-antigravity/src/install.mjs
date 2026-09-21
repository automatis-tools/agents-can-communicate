import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { blankJson, removeIfEmpty, writeForeignJson, writeHookShim }
  from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const run = promisify(execFile);

/**
 * The top-level key this client namespaces hooks by. It is also the identity
 * uninstall removes by, which is why it is a constant rather than a string
 * repeated in three places.
 */
export const ACC_NAMESPACE = "acc";

/**
 * The events ACC registers, out of the four that load.
 *
 * `PostInvocation` is left out deliberately. It fires with an envelope
 * byte-identical to `PreInvocation`'s for the same invocation, and there is
 * nothing ACC would do there that `PreInvocation` has not already done - so
 * registering it would double this client's hook cost for no behaviour.
 */
export const ACC_REGISTERED_EVENTS = Object.freeze(["SessionStart", "PreInvocation", "Stop"]);

/**
 * Where a registration can go, and which one is used when nobody says.
 *
 * Global, decided in issue #178. It always loads, and it is where ACC already
 * registers for every other client that keeps hooks in the user's home. The
 * alternative is scoped to one project and does nothing at all unless that
 * project is an open Antigravity workspace - and a default that silently
 * registers nothing is worse than one that is broader than a given project
 * needs. `ACC_ANTIGRAVITY_HOOKS=workspace` selects the other one.
 *
 * A value that is neither is refused rather than replaced by this default. On
 * this client, quietly answering a different question from the one that was
 * asked is the failure mode every other note in this package is about.
 */
export const HOOK_LOCATIONS = Object.freeze(["global", "workspace"]);
export const DEFAULT_HOOK_LOCATION = "global";

const locationOf = context => context?.antigravityHookLocation ?? DEFAULT_HOOK_LOCATION;

export const globalHooksPath = home => path.join(home, ".gemini", "config", "hooks.json");
export const workspaceHooksPath = workspace => path.join(workspace, ".agents", "hooks.json");

// Where this client keeps the plugins it imports by itself, including the copy
// of ACC's Gemini CLI extension it makes without registering any of it.
const importedPluginPath = home => path.join(home, ".gemini", "antigravity-cli", "plugins",
  "agents-can-communicate");
const shimDir = home => path.join(home, ".gemini", "config", "acc");
/**
 * Where "ACC created this file" is recorded.
 *
 * In ACC's own data home, not in the client's tree and not in the shim
 * directory. Two reasons, one of which cost a real uninstall:
 *
 * - This client reads every top-level key of `hooks.json` as an integration
 *   namespace, and one it cannot read drops the whole file. A marker inside the
 *   file registers nothing at all, valid namespaces included
 *   (`fixtures/hooks-readback-foreign-key-1.2.7.json`).
 * - The installer removes every recorded artifact *before* it calls
 *   `uninstall`, and the shim directory is a recorded artifact. A marker kept
 *   there is already gone by the time uninstall reads it, so a `hooks.json` ACC
 *   created is judged to be the user's and left behind. Observed on a real
 *   machine: `acc uninstall` reported success and left `{}` in
 *   `~/.gemini/config/hooks.json`.
 *
 * One marker per registration location, so a global and a workspace install on
 * the same machine cannot claim each other's file. The shim directory remains
 * the fallback for a direct adapter caller with no data home, which is how the
 * adapter is used outside the installer.
 */
const createdMarkerDir = ({ dataHome, home }) => typeof dataHome === "string" && dataHome !== ""
  ? path.join(dataHome, "acc", "adapter-antigravity")
  : shimDir(home);
const createdMarker = (context, file) => path.join(createdMarkerDir(context),
  `created-${Buffer.from(file).toString("base64url")}`);

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

/**
 * Resolve the one file this install owns.
 *
 * Both locations are implemented and both are tested. Which one is used is an
 * input, never an assumption.
 */
export function hooksPathFor(context) {
  const { home, antigravityWorkspace } = context;
  const location = locationOf(context);
  if (!HOOK_LOCATIONS.includes(location)) {
    usage(`${JSON.stringify(location)} is not an Antigravity hook location: use global `
      + `(${globalHooksPath(String(home))}, always loads, applies to every session on this `
      + "machine) or workspace (<project>/.agents/hooks.json, scoped to one project and "
      + "inert unless that project is an open Antigravity workspace)",
    { location: location ?? null, known: [...HOOK_LOCATIONS] });
  }
  if (location === "global") return globalHooksPath(home);
  if (typeof antigravityWorkspace !== "string" || antigravityWorkspace === "") {
    usage("a workspace registration needs the project directory to write it into",
      { location });
  }
  return workspaceHooksPath(antigravityWorkspace);
}

/**
 * Read a client's own JSON, and say which file when it will not parse.
 *
 * Two files can be called `hooks.json` on this machine and one of them belongs
 * to a different client entirely, so the path goes in the message.
 */
async function readJson(file, fallback) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new AccError(EXIT.DATA, `${file} is not valid JSON: ${error.message}`,
      { file, cause: error.message });
  }
}

const exists = async target => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * The config this client loads.
 *
 * Namespaced by integration, then by event, and each action is flat. No
 * `matcher`, no nested `hooks` array, no top-level `hooks` wrapper: all three
 * are the Gemini CLI shape, all three parse, and all three register nothing.
 *
 * Each command carries its own event name, because the payload does not. The
 * same shim answers every event and is told which one it is running as.
 */
export function accHookConfig(shim) {
  return { [ACC_NAMESPACE]: Object.fromEntries(ACC_REGISTERED_EVENTS.map(event =>
    [event, [{ type: "command", command: `sh "${shim}" ${event}`, timeout: 10 }]])) };
}

/**
 * The events ACC actually has registered, according to the client.
 *
 * This reads the effective hook list - what `agy -p "/hooks"` answers - and
 * never the file that was written. The two disagree in at least four captured
 * ways: the Gemini shape loads nothing, an unsupported event name is dropped
 * out of an otherwise valid namespace, 1.2.4 fixed the whole file being dropped
 * under customization token budget truncation, and 1.1.1 fixed a workspace file
 * not loading after a folder was trusted. Every one of them looks identical on
 * disk to a registration that works.
 */
export function registeredEvents(readback) {
  const hooks = Array.isArray(readback?.hooks) ? readback.hooks : [];
  const ours = hooks.find(entry => entry?.name === ACC_NAMESPACE && entry.enabled === true);
  const actions = Array.isArray(ours?.actions) ? ours.actions : [];
  const events = actions.map(action => action?.event)
    .filter(event => ACC_REGISTERED_EVENTS.includes(event));
  // In the order ACC registers them, so a caller can compare and subtract
  // without sorting two lists that mean the same thing.
  return ACC_REGISTERED_EVENTS.filter(event => events.includes(event));
}

/** Which file the live registration was actually loaded from. */
export function registeredSource(readback) {
  const hooks = Array.isArray(readback?.hooks) ? readback.hooks : [];
  return hooks.find(entry => entry?.name === ACC_NAMESPACE)?.source ?? null;
}

/**
 * Ask the client what it has loaded.
 *
 * `/hooks` in print mode answers without starting a turn: changelog 1.1.12
 * records that a print-mode slash command costs no quota and runs no model.
 * A workspace file is only read when its directory is an open workspace, and in
 * print mode that means passing it with `--add-dir`.
 */
export async function probeInstalledHooks({ antigravityWorkspace, antigravityHookLocation,
  command = "agy", timeoutMs = 60_000, env } = {}) {
  const args = ["-p", "/hooks", "--output-format", "json",
    ...(antigravityHookLocation === "workspace" && typeof antigravityWorkspace === "string"
      ? ["--add-dir", antigravityWorkspace] : [])];
  const { stdout } = await run(command, args, { timeout: timeoutMs, env });
  const parsed = JSON.parse(stdout);
  const data = parsed?.command?.data;
  if (data === undefined || data === null) {
    throw new AccError(EXIT.DATA, "agy did not answer /hooks with a hook list",
      { received: Object.keys(parsed ?? {}) });
  }
  return data;
}

const probeFor = context => context.probeHooks ?? probeInstalledHooks;

/**
 * Write the registration, then make the client prove it.
 *
 * The write is never the answer. This client accepts a config it will not load
 * and reports nothing, so the install is finished by asking what actually
 * loaded and refusing when the two disagree. The refusal throws, because that
 * is the only thing `acc install` reports as a failure; a returned `ok: false`
 * would be recorded as a successful install.
 */
export async function installAntigravity(context) {
  const { home, runner, node } = context;
  const file = hooksPathFor(context);
  const found = await readJson(file, null);
  const existing = found ?? {};

  const shim = await writeHookShim({ dir: shimDir(home), adapterId: "antigravity",
    runner, node });
  const merged = { ...existing, ...accHookConfig(shim) };
  await mkdir(path.dirname(file), { recursive: true });
  await writeForeignJson(file, merged, { readFile, writeFile, mkdir });
  // Recorded beside the shim, never inside the client's file. A file holding
  // only ACC's namespace looks the same whether ACC created it or the user did,
  // and uninstall has to know which - but this client reads every top-level key
  // as a namespace, and one it cannot read drops the whole file. A marker
  // written the way the Gemini CLI adapter writes its own registered nothing at
  // all, valid namespace included: fixtures/hooks-readback-foreign-key-1.2.7.json.
  if (found === null) {
    await mkdir(createdMarkerDir(context), { recursive: true });
    await writeFile(createdMarker(context, file), `${file}\n`);
  }
  const changes = [shimDir(home), file];

  const diagnostics = [];
  if (locationOf(context) === "workspace") {
    diagnostics.push("a workspace registration loads only while this project is an open "
      + `Antigravity workspace; in print mode pass --add-dir ${context.antigravityWorkspace}`);
  }

  let readback;
  try {
    readback = await probeFor(context)(context);
  } catch (error) {
    // The client could not be asked. Say so and claim nothing: an unverifiable
    // write is exactly the state this adapter exists to stop reporting as done.
    return { ok: true, changes, diagnostics: [...diagnostics,
      `wrote ${file} but could not read the effective hook list back (${error.message}); `
      + "verify with: agy -p \"/hooks\" --output-format json"],
    needsAction: ["run agy -p \"/hooks\" --output-format json and confirm the acc namespace "
      + "lists SessionStart, PreInvocation and Stop"] };
  }
  const loaded = registeredEvents(readback);
  const dropped = ACC_REGISTERED_EVENTS.filter(event => !loaded.includes(event));
  if (dropped.length > 0) {
    throw new AccError(EXIT.DATA,
      loaded.length === 0
        ? `${file} was written and registered nothing: agy reports no enabled `
          + `${ACC_NAMESPACE} hooks. The file parsed; this client drops a configuration `
          + "it does not recognise without logging anything."
        : `${file} is only partly registered: agy loaded ${loaded.join(", ")} and dropped `
          + `${dropped.join(", ")}.`,
      { file, loaded, dropped, source: registeredSource(readback) });
  }
  const source = registeredSource(readback);
  return { ok: true, changes, diagnostics: [...diagnostics,
    `acc hooks registered: ${loaded.join(", ")} loaded from ${source ?? file}`] };
}

/**
 * Remove what this adapter wrote, and nothing else.
 *
 * Ownership is the `acc` namespace key. Every other key in the file belongs to
 * somebody else and is written back exactly as it was. Nothing here reads or
 * writes `~/.gemini/settings.json` or `~/.gemini/extensions/`: those are the
 * Gemini CLI integration's, in a tree the two clients share.
 */
export async function uninstallAntigravity(context) {
  const { home, keep = [] } = context;
  const changes = [];
  for (const file of [globalHooksPath(home),
    ...(typeof context.antigravityWorkspace === "string"
      ? [workspaceHooksPath(context.antigravityWorkspace)] : [])]) {
    const existing = await readJson(file, null);
    if (existing === null || !Object.hasOwn(existing, ACC_NAMESPACE)) continue;
    const next = { ...existing };
    delete next[ACC_NAMESPACE];
    await writeForeignJson(file, next, { readFile, writeFile, mkdir });
    const marker = createdMarker(context, file);
    const created = await exists(marker);
    await removeIfEmpty(file, { readFile, rm, isEmpty: blankJson(), created });
    if (created) await rm(marker, { force: true });
    changes.push(file);
  }
  if (!keep.includes(shimDir(home))) await rm(shimDir(home), { recursive: true, force: true });
  return { ok: true, changes, diagnostics: [] };
}

/**
 * What is true on this machine, read from the client rather than from disk.
 *
 * The state issue #176 describes is the one worth naming: AGY copies ACC's
 * Gemini CLI extension into its own plugin directory on first authenticated
 * run, byte for byte, and registers none of it. A machine can therefore hold a
 * complete copy of the ACC integration while ACC is invisible to the client.
 * "The files are there" has to stop being read as "it is installed".
 */
/**
 * Whether this install can proceed as asked.
 *
 * Only an unrecognised location blocks it. Unset is not unrecognised - that is
 * the default, `global`. A misspelling is, and it is named rather than silently
 * replaced: an operator who asked for `workspace` and got the machine-wide file
 * has no way of finding out except by reading the file.
 */
export function locationChoice(context) {
  const location = locationOf(context);
  return HOOK_LOCATIONS.includes(location) ? null
    : { reason: `ACC_ANTIGRAVITY_HOOKS is ${JSON.stringify(location)}, which is not a place `
      + "this client reads hooks from: use global "
      + `(${globalHooksPath(String(context?.home ?? "~"))}, always loads, applies to every `
      + "Antigravity session on this machine) or workspace (<project>/.agents/hooks.json, "
      + "scoped to one project and loaded only while it is an open Antigravity workspace)" };
}

export async function detectAntigravity(context) {
  const diagnostics = [];
  const blocked = locationChoice(context);
  const imported = await exists(importedPluginPath(context.home));
  let readback = null;
  try {
    readback = await probeFor(context)(context);
  } catch (error) {
    diagnostics.push(`acc hooks not registered: could not ask agy what it has loaded `
      + `(${error.message})`);
  }
  if (readback !== null) {
    const loaded = registeredEvents(readback);
    diagnostics.push(loaded.length === ACC_REGISTERED_EVENTS.length
      ? `acc hooks registered: ${loaded.join(", ")} loaded from `
        + `${registeredSource(readback) ?? "an unnamed source"}`
      : loaded.length === 0 ? "acc hooks not registered"
        : `acc hooks not registered completely: agy loaded ${loaded.join(", ")} and is `
          + `missing ${ACC_REGISTERED_EVENTS.filter(e => !loaded.includes(e)).join(", ")}`);
  }
  if (imported && (readback === null || registeredEvents(readback).length === 0)) {
    diagnostics.push("an imported plugin directory for agents-can-communicate exists at "
      + `${importedPluginPath(context.home)} and registers nothing: this client copies the `
      + "Gemini CLI extension on first run and reads none of its hook names (issue #176)");
  }
  if (blocked !== null) diagnostics.push(blocked.reason);
  return { ok: true, changes: [], diagnostics,
    ...(blocked === null ? {} : { blocked, needsAction: [blocked.reason] }) };
}

export async function doctorAntigravity(context) {
  const detected = await detectAntigravity(context);
  const diagnostics = [...detected.diagnostics,
    "hook payloads carry no hook_event_name; each registered command passes its own event name",
    "only SessionStart, PreInvocation, PostInvocation and Stop load; SessionEnd, PreToolUse "
      + "and PostToolUse are accepted into the file and silently dropped, so this client has "
      + "no tool guard and no session end",
    "Stop continuation is a bounded nudge, not a gate: this adapter continues a turn at most "
      + "once and fails open, and the client caps consecutive continuations itself (1.1.9)",
    // The one failure a healthy registration can still produce, and the reason
    // this line exists at all: the hook runs, finds no project in the payload,
    // fails open, and this client does not show hook stderr. Nothing else on
    // the machine would ever tell the operator.
    "hooks only attach a session when the Antigravity session has an open workspace: the "
      + "TUI started in a project directory has one, but a print-mode `agy -p` there sends an "
      + "empty workspacePaths and the hook has no project to join. Open the project as an "
      + "Antigravity workspace, or pass it with --add-dir"];
  if (locationOf(context) === "workspace") {
    diagnostics.push("registered per workspace; a session opened anywhere else loads nothing");
  }
  return { ok: true, changes: [], diagnostics };
}

/**
 * The paths an install would write, without writing them. Same helpers as the
 * install, so a dry run cannot drift from what actually happens.
 */
export function planAntigravityInstall(context) {
  const shim = { path: shimDir(context.home), kind: "tree" };
  // With no location chosen there is no install to describe, and an uninstall
  // still has to be describable: the planner asks for the artifacts of a client
  // that is present whichever way the command is going. So both candidates are
  // named - which is what uninstall already scans - rather than throwing and
  // making a recorded install unremovable. An install never reaches here
  // unchosen; `locationChoice` blocks it one step earlier.
  if (locationChoice(context) !== null) {
    return [shim,
      { path: globalHooksPath(context.home), kind: "merge" },
      ...(typeof context.antigravityWorkspace === "string" && context.antigravityWorkspace !== ""
        ? [{ path: workspaceHooksPath(context.antigravityWorkspace), kind: "merge" }] : [])];
  }
  return [shim, { path: hooksPathFor(context), kind: "merge" }];
}

/**
 * Refuse a removal that would take somebody else's file with it.
 *
 * Read-only, and it runs before the installer deletes any recorded artifact.
 */
export async function preflightAntigravityUninstall(context) {
  for (const file of [globalHooksPath(context.home),
    ...(typeof context.antigravityWorkspace === "string"
      ? [workspaceHooksPath(context.antigravityWorkspace)] : [])]) {
    const existing = await readJson(file, null);
    if (existing === null) continue;
    if (typeof existing !== "object" || Array.isArray(existing)) {
      throw new AccError(EXIT.DATA,
        `${file} is not a hook configuration object; refusing to edit it`, { file });
    }
  }
  return { ok: true, changes: [], diagnostics: [] };
}
