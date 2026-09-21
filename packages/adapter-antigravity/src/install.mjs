import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { bakeSkillCommand, blankJson, ownVersion, removeIfEmpty, stampPluginVersion,
  writeCliShim, writeForeignJson, writeHookShim }
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
 * The plugin that carries ACC's skill for this client, and the id the skill
 * then has.
 *
 * Deliberately not `agents-can-communicate`. On first authenticated run this
 * client copies ACC's Gemini CLI extension into its own plugin directory under
 * that name, and a plugin installed under the same name is silently shadowed
 * by the copy: /skills listed only the imported one
 * (`fixtures/plugin-name-collision-1.2.7.json`). The copy is not ACC's to
 * rely on - every command in it points at the Gemini CLI extension's shim, so
 * it works exactly as long as Gemini CLI is wired and not a moment longer.
 */
export const ACC_PLUGIN_NAME = "acc";
export const ACC_SKILL_ID = `${ACC_PLUGIN_NAME}:acc`;
const IMPORTED_COPY_SKILL_ID = "agents-can-communicate:acc";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));

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
// Where `agy plugin install` copies a plugin, and the manifest it records the
// install in. Both belong to the client; ACC reaches them only through `agy`.
export const pluginInstallPath = home => path.join(home, ".gemini", "config", "plugins",
  ACC_PLUGIN_NAME);
export const vendorManifestPath = home => path.join(home, ".gemini", "config",
  "import_manifest.json");
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
 * Run the client's own binary, against the home ACC is working in.
 *
 * `HOME` is set explicitly. The binary honours it, and every answer it gives -
 * what is registered, which skills load, where a plugin is installed - is an
 * answer about that home. Inheriting the caller's would verify the machine the
 * operator is sitting at rather than the one `acc install --home` wrote to.
 */
async function runAgy(args, { home, env, timeoutMs = 60_000 } = {}) {
  return run("agy", args, { timeout: timeoutMs,
    env: { ...process.env, ...env, ...(typeof home === "string" ? { HOME: home } : {}) } });
}

const agyFor = context => context.runAgy ?? runAgy;

/**
 * A print-mode slash command's data, or a reason it has none.
 *
 * These answer without a turn: changelog 1.1.12 records that a print-mode slash
 * command costs no quota and runs no model. They still need a signed-in
 * account - captured: an unauthenticated home answers
 * `authentication failed or timed out` - and that is said as such, because
 * "could not ask" and "asked, and nothing is registered" are different states.
 */
async function slashCommand(context, command, extra = []) {
  const { stdout } = await agyFor(context)(["-p", command, "--output-format", "json", ...extra],
    { home: context.home, env: context.env });
  const parsed = JSON.parse(stdout);
  const data = parsed?.command?.data;
  if (data === undefined || data === null) {
    const reason = typeof parsed?.error === "string" && /auth/i.test(parsed.error)
      ? "this home has no signed-in Antigravity account"
      : `agy did not answer ${command}`;
    throw new AccError(EXIT.DATA, reason, { command, received: Object.keys(parsed ?? {}) });
  }
  return data;
}

/**
 * Ask the client what it has loaded.
 *
 * A workspace file is only read when its directory is an open workspace, and in
 * print mode that means passing it with `--add-dir`.
 */
export async function probeInstalledHooks(context = {}) {
  const { antigravityWorkspace } = context;
  return slashCommand(context, "/hooks",
    locationOf(context) === "workspace" && typeof antigravityWorkspace === "string"
      ? ["--add-dir", antigravityWorkspace] : []);
}

export const probeInstalledSkills = context => slashCommand(context, "/skills");

const probeFor = context => context.probeHooks ?? probeInstalledHooks;

/**
 * ACC's own skill, if the client loaded it from where ACC installed it.
 *
 * The id alone is not enough: a same-named skill from somewhere else would
 * answer to it. The path is what says it is the copy this install put there.
 */
export function registeredSkill(readback, home) {
  const skills = Array.isArray(readback?.skills) ? readback.skills : [];
  return skills.find(skill => skill?.name === ACC_SKILL_ID && skill.model_invocable !== false
    && typeof skill.path === "string"
    && !path.relative(pluginInstallPath(home), skill.path).startsWith("..")) ?? null;
}

const importedCopy = readback => (Array.isArray(readback?.skills) ? readback.skills : [])
  .find(skill => skill?.name === IMPORTED_COPY_SKILL_ID) ?? null;

/**
 * Write the registration, then make the client prove it.
 *
 * The write is never the answer. This client accepts a config it will not load
 * and reports nothing, so the install is finished by asking what actually
 * loaded and refusing when the two disagree. The refusal throws, because that
 * is the only thing `acc install` reports as a failure; a returned `ok: false`
 * would be recorded as a successful install.
 */
/**
 * Give this client ACC's skill, through the client's own plugin manager.
 *
 * Staged in a temporary directory rather than anywhere this client discovers
 * customizations, so no half-built copy is ever loaded, then handed to
 * `agy plugin install`, which copies the whole directory to
 * `~/.gemini/config/plugins/acc/` and records it in its manifest
 * (`fixtures/plugin-install-lifecycle-1.2.7.json`). Installing again
 * overwrites, which is what makes this idempotent.
 *
 * The command the skill teaches is ACC's own CLI shim, in ACC's shim
 * directory, so it outlives the Gemini CLI integration this client otherwise
 * borrows from.
 */
async function installSkillPlugin(context) {
  const { home, cli, node } = context;
  const manifestExisted = await exists(vendorManifestPath(home));
  const cliShim = await writeCliShim({ dir: shimDir(home), cli, node });
  const stage = await mkdtemp(path.join(tmpdir(), "acc-antigravity-plugin-"));
  try {
    const plugin = path.join(stage, ACC_PLUGIN_NAME);
    await cp(bundle, plugin, { recursive: true });
    await stampPluginVersion({ file: path.join(plugin, "plugin.json"),
      version: await ownVersion(import.meta.url), io: { readFile, writeFile } });
    await bakeSkillCommand({ root: plugin, cliShim });
    await agyFor(context)(["plugin", "install", plugin], { home, env: context.env });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  // agy creates its manifest on first install and leaves it behind, holding
  // `{"imports": null}`, on uninstall. Whether ACC's install is the reason it
  // exists is recorded now, while that is still knowable.
  if (!manifestExisted) {
    await mkdir(createdMarkerDir(context), { recursive: true });
    await writeFile(createdMarker(context, vendorManifestPath(home)),
      `${vendorManifestPath(home)}\n`);
  }
}

/**
 * Write the registration, then make the client prove it.
 *
 * The write is never the answer. This client accepts a config it will not load
 * and reports nothing, so the install is finished by asking what actually
 * loaded and refusing when the two disagree. The refusal throws, because that
 * is the only thing `acc install` reports as a failure; a returned `ok: false`
 * would be recorded as a successful install.
 *
 * An answer the client cannot give is not a refusal. A home with no signed-in
 * account cannot run a print-mode slash command, and that is reported as
 * unverified - never as registered.
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
  await installSkillPlugin(context);
  const changes = [shimDir(home), file, pluginInstallPath(home), vendorManifestPath(home)];

  const diagnostics = [];
  const needsAction = [];
  if (locationOf(context) === "workspace") {
    diagnostics.push("a workspace registration loads only while this project is an open "
      + `Antigravity workspace; in print mode pass --add-dir ${context.antigravityWorkspace}`);
  }

  let readback = null;
  try {
    readback = await probeFor(context)(context);
  } catch (error) {
    // The client could not be asked. Say so and claim nothing: an unverifiable
    // write is exactly the state this adapter exists to stop reporting as done.
    diagnostics.push(`wrote ${file} but could not read the effective hook list back `
      + `(${error.message}); verify with: agy -p "/hooks" --output-format json`);
    needsAction.push("run agy -p \"/hooks\" --output-format json and confirm the acc "
      + "namespace lists SessionStart, PreInvocation and Stop");
  }
  if (readback !== null) {
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
    diagnostics.push(`acc hooks registered: ${loaded.join(", ")} loaded from `
      + `${registeredSource(readback) ?? file}`);
  }

  let skills = null;
  try {
    skills = await probeInstalledSkills(context);
  } catch (error) {
    diagnostics.push(`installed the ${ACC_PLUGIN_NAME} plugin but could not read the skill `
      + `list back (${error.message}); verify with: agy -p "/skills" --output-format json`);
    needsAction.push(`run agy -p "/skills" --output-format json and confirm ${ACC_SKILL_ID} `
      + "is listed");
  }
  if (skills !== null) {
    const skill = registeredSkill(skills, home);
    if (skill === null) {
      throw new AccError(EXIT.DATA,
        `installed the ${ACC_PLUGIN_NAME} plugin and the client does not list ${ACC_SKILL_ID} `
        + `from ${pluginInstallPath(home)}: the copy is on disk and not loaded`,
        { plugin: pluginInstallPath(home) });
    }
    diagnostics.push(`acc skill registered: ${ACC_SKILL_ID} loaded from ${skill.path}`);
  }
  return { ok: true, changes, diagnostics, ...(needsAction.length > 0 ? { needsAction } : {}) };
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
  const diagnostics = [];
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

  // The plugin goes back through the client that installed it, so its manifest
  // entry goes with it. Removing the directory by hand would leave agy listing a
  // plugin that is not there. Only when agy itself cannot be run is the copy
  // removed directly - an ACC skill whose command is about to disappear must
  // not stay behind for a model to follow.
  if (await exists(pluginInstallPath(home))) {
    try {
      await agyFor(context)(["plugin", "uninstall", ACC_PLUGIN_NAME],
        { home, env: context.env });
    } catch (error) {
      await rm(pluginInstallPath(home), { recursive: true, force: true });
      diagnostics.push(`agy plugin uninstall ${ACC_PLUGIN_NAME} failed (${error.message}); `
        + `removed ${pluginInstallPath(home)} directly, and agy may still list it`);
    }
    changes.push(pluginInstallPath(home));
  }
  // What agy leaves after the last uninstall: `{"imports": null}`, in a file
  // that did not exist before ACC's install. Taken away only when ACC's install
  // is why it exists and nothing but that null is left in it.
  const manifest = vendorManifestPath(home);
  const manifestMarker = createdMarker(context, manifest);
  if (await exists(manifestMarker)) {
    const current = await readJson(manifest, null).catch(() => undefined);
    const empty = current !== undefined && current !== null
      && Object.keys(current).every(key => key === "imports")
      && (current.imports === null || (Array.isArray(current.imports)
        && current.imports.length === 0));
    if (empty) {
      await rm(manifest, { force: true });
      changes.push(manifest);
    }
    await rm(manifestMarker, { force: true });
  }

  if (!keep.includes(shimDir(home))) await rm(shimDir(home), { recursive: true, force: true });
  return { ok: true, changes, diagnostics };
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
  const needsAction = [];
  const blocked = locationChoice(context);
  const imported = await exists(importedPluginPath(context.home));
  // The installer runs every adapter's detect and passes a null version for a
  // client it did not find. Asking agy then would spawn a binary the installer
  // could not run a moment ago, or - where it does exist but did not answer -
  // let it write its own state into a home nobody asked it about.
  if (context.clientVersion === null) {
    diagnostics.push("acc hooks not registered: Antigravity CLI was not found, so it was "
      + "not asked what it has loaded");
    if (blocked !== null) diagnostics.push(blocked.reason);
    return { ok: true, changes: [], diagnostics, ...(blocked === null ? {} : { blocked }) };
  }
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

  let skills = null;
  try {
    skills = await probeInstalledSkills(context);
  } catch (error) {
    diagnostics.push(`acc skill unverified: could not ask agy which skills it loads `
      + `(${error.message})`);
  }
  const hooksLoaded = readback !== null && registeredEvents(readback).length > 0;
  if (skills !== null) {
    const skill = registeredSkill(skills, context.home);
    if (skill !== null) {
      diagnostics.push(`acc skill registered: ${ACC_SKILL_ID} loaded from ${skill.path}`);
    } else {
      diagnostics.push(`acc skill ${ACC_SKILL_ID} is not loaded`);
      // Hooks without the skill deliver peer messages to an agent that has no
      // instructions for answering them. That is a reinstall, not a footnote.
      if (hooksLoaded) {
        needsAction.push(`acc install --adapter antigravity  # ${ACC_SKILL_ID} is not loaded, `
          + "so an agent here receives peer messages with no instructions for answering");
      }
    }
    const copy = importedCopy(skills);
    if (copy !== null) {
      diagnostics.push(`${IMPORTED_COPY_SKILL_ID} is this client's own copy of ACC's Gemini `
        + `CLI extension, imported on first run from ${copy.path}. It is loaded, but it is not `
        + `ACC's: every command in it runs the Gemini CLI extension's shim, so it stops `
        + `working when Gemini CLI is unwired. ${ACC_SKILL_ID} is the one ACC installs here`);
    }
  }
  if (imported && !hooksLoaded) {
    diagnostics.push("an imported plugin directory for agents-can-communicate exists at "
      + `${importedPluginPath(context.home)}: this client copies the Gemini CLI extension on `
      + "first run and loads its skill, but none of its hook names, so no ACC hook runs here "
      + "(issue #176)");
  }
  if (blocked !== null) {
    diagnostics.push(blocked.reason);
    needsAction.push(blocked.reason);
  }
  return { ok: true, changes: [], diagnostics,
    ...(blocked === null ? {} : { blocked }),
    ...(needsAction.length > 0 ? { needsAction } : {}) };
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
  // The plugin and the manifest agy records it in are the client's, reached
  // only through `agy plugin`. Declared as delegated - `merge` is the kind the
  // installer leaves to the adapter - so the installer never deletes the copy
  // ahead of `agy plugin uninstall` and strands its manifest entry. That exact
  // ordering, with the shim directory, once left `{}` behind in the user's home.
  const plugin = [{ path: pluginInstallPath(context.home), kind: "merge" },
    { path: vendorManifestPath(context.home), kind: "merge" }];
  if (locationChoice(context) !== null) {
    return [shim, ...plugin,
      { path: globalHooksPath(context.home), kind: "merge" },
      ...(typeof context.antigravityWorkspace === "string" && context.antigravityWorkspace !== ""
        ? [{ path: workspaceHooksPath(context.antigravityWorkspace), kind: "merge" }] : [])];
  }
  return [shim, ...plugin, { path: hooksPathFor(context), kind: "merge" }];
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
