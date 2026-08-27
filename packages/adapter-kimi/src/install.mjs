import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { fileURLToPath } from "node:url";

import { assertRunner, bakeSkillCommand, blankText, defaultRunner, removeIfEmpty,
  ownVersion, stampPluginVersion,
  removeInstalledTree, runnerExists, writeForeignJson }
  from "@agents-can-communicate/adapter-sdk";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const PLUGIN_NAME = "agents-can-communicate";

// The block markers are the whole ownership story. This client keeps its hooks
// in the user's TOML config, and ACC ships without dependencies, so parsing and
// re-emitting that file would mean writing a TOML round-tripper and losing the
// user's comments and formatting to it. Instead ACC owns a delimited region and
// never reads the rest: install replaces the region, uninstall deletes it, and
// everything outside comes back byte for byte.
export const BEGIN = "# >>> agents-can-communicate (managed; edits here are overwritten)";
export const END = "# <<< agents-can-communicate";

// Seconds, not milliseconds. A hook that sleeps 3s dies under `timeout = 1`,
// which is how this was settled; copying another harness's `10000` would have
// let a hung hook stall a turn for the better part of three hours.
const TIMEOUT_SECONDS = 10;

// Only events observed firing get wired. Guard events carry the matcher, which
// was proven to select: "NoSuchTool" never fired, "Write|Edit|Bash" fired twice.
const WIRING = Object.freeze([
  { event: "SessionStart", kind: "sessionStart" },
  { event: "UserPromptSubmit", kind: "beforeTurn" },
  { event: "SessionHeartbeat", kind: "heartbeat" },
  { event: "PreToolUse", kind: "beforeTool", matcher: "Write|Edit|Bash" },
  { event: "Stop", kind: "turnEnd" },
]);

const configPath = home => path.join(home, "config.toml");
const pluginPath = home => path.join(home, "plugins", "managed", PLUGIN_NAME);
const registryPath = home => path.join(home, "plugins", "installed.json");

// This client's config has no variable to stand in for an install directory -
// unlike the plugin manifests of the other three, which expand a plugin root -
// so the runner is written in as an absolute path at install time. Codex taught
// this the hard way: a relative hook command fails silently, hook after hook.

// TOML basic strings take backslash escapes. A path is user-controlled input
// here, so it is escaped rather than trusted to be boring.
const tomlString = value => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function readText(file, fallback) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * Read a client's own JSON, and say which file when it will not parse.
 *
 * A malformed config is the user's to fix, and the message they get has to name
 * it. `Unexpected end of JSON input` arrived with no path attached, from an
 * install that touches four clients' homes, and left them to guess which.
 */
async function readJson(file, fallback) {
  const source = await readText(file, null);
  if (source === null) return fallback;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new AccError(EXIT.DATA, `${file} is not valid JSON: ${error.message}`,
      { file, cause: error.message });
  }
}

/**
 * Remove ACC's region and nothing else.
 *
 * Written to survive a config that has no block, several blocks, or a block the
 * user has half-deleted: an unterminated marker consumes to end of file rather
 * than leaving stray `[[hooks]]` entries that would fail the client's schema
 * and lock the user out of their own tool.
 */
export function stripBlock(source) {
  const lines = source.split("\n");
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (line.trimEnd() === BEGIN) { inside = true; continue; }
    if (inside) {
      if (line.trimEnd() === END) inside = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

export function renderBlock(runner, node = process.execPath) {
  const entries = WIRING.map(({ event, kind, matcher }) => {
    // Both paths are shell-quoted inside the TOML string: a hook runs through a
    // shell, and a space in either path would otherwise split the command.
    // The interpreter is named outright rather than left to PATH, which a hook's
    // environment does not reliably carry.
    const command = `${tomlString(node)} ${tomlString(runner)} kimi ${kind}`;
    const lines = ["[[hooks]]", `event = ${tomlString(event)}`,
      `command = ${tomlString(command)}`];
    if (matcher !== undefined) lines.push(`matcher = ${tomlString(matcher)}`);
    lines.push(`timeout = ${TIMEOUT_SECONDS}`);
    return lines.join("\n");
  });
  return [BEGIN, ...entries, END].join("\n");
}

const registerPlugin = (registry, root) => {
  const plugins = (registry.plugins ?? []).filter(entry => entry.id !== PLUGIN_NAME);
  return { ...registry, version: registry.version ?? 1,
    plugins: [...plugins, { id: PLUGIN_NAME, root, source: "local", enabled: true }] };
};

export async function installKimiPlugin({ home, runner = defaultRunner(), node }) {
  // A hook whose command does not exist fails silently, on every event, for as
  // long as it stays installed: the client reports nothing and ACC simply never
  // sees a session. Writing that entry and hoping is worse than refusing.
  await assertRunner(runner);
  // Read before writing: a registry that will not parse must be found before a
  // plugin tree is laid down that nothing will then be able to remove.
  const registered = await readJson(registryPath(home), { version: 1, plugins: [] });

  const target = pluginPath(home);
  await rm(target, { recursive: true, force: true });
  await cp(bundle, target, { recursive: true });
  // The copy this client reads says which ACC wrote it. Nothing here reads it
  // back, but a manifest that names a version it is not is a lie either way.
  await stampPluginVersion({ file: path.join(target, ".kimi-plugin", "plugin.json"),
    version: await ownVersion(import.meta.url), io: { readFile, writeFile } });
  // The skill ships with a placeholder where the command belongs: `acc` is
  // not on PATH everywhere, and an agent that cannot run it improvises.
  await bakeSkillCommand({ root: target, node });

  const file = configPath(home);
  const existing = await readText(file, "");
  const withoutOurs = stripBlock(existing);
  // A block appended at top level closes whatever table preceded it, so the
  // user's last section cannot swallow our entries.
  const separator = withoutOurs === "" || withoutOurs.endsWith("\n") ? "" : "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${withoutOurs}${separator}${renderBlock(runner, node)}\n`);

  const registry = registryPath(home);
  await mkdir(path.dirname(registry), { recursive: true });
  await writeForeignJson(registry, registerPlugin(registered, target),
    { readFile, writeFile, mkdir });

  return { ok: true, changes: [target, file, registry], diagnostics: [] };
}

export async function uninstallKimiPlugin({ home, keep = [] }) {
  const file = configPath(home);
  const existing = await readText(file, null);
  const changes = [];
  if (existing !== null) {
    const stripped = stripBlock(existing);
    if (stripped !== existing) changes.push(file);
    await writeFile(file, stripped);
  }

  const registry = registryPath(home);
  const loaded = await readJson(registry, null);
  if (loaded !== null) {
    const plugins = (loaded.plugins ?? []).filter(entry => entry.id !== PLUGIN_NAME);
    if (plugins.length !== (loaded.plugins ?? []).length) changes.push(registry);
    // The registry exists because a plugin was installed. Leaving an empty one
    // behind is litter in a home that had no such file - measured after an
    // uninstall that was otherwise clean. An empty registry and an absent one
    // mean the same thing to this client.
    if (plugins.length > 0) {
      await writeForeignJson(registry, { ...loaded, plugins },
        { readFile, writeFile, mkdir });
    } else {
      await rm(registry, { force: true });
    }
  }

  // Blank and absent are the same to this client, so there is nothing to lose
  // by removing a config that holds nothing - and no record of who created it is
  // needed, unlike a JSON settings file where `{}` can be the user's own.
  await removeIfEmpty(configPath(home), { readFile, rm, isEmpty: blankText });

  await removeInstalledTree(pluginPath(home), keep);
  return { ok: true, changes, diagnostics: [] };
}

export async function detectKimi({ home, runner = defaultRunner() }) {
  const source = await readText(configPath(home), "");
  const installed = source.includes(BEGIN);
  const registry = await readJson(registryPath(home), null);
  const registered = (registry?.plugins ?? []).some(entry => entry.id === PLUGIN_NAME);
  return { ok: true, changes: [], diagnostics: [
    installed ? "acc hooks registered in config.toml" : "acc hooks not registered",
    registered ? "acc plugin registered" : "acc plugin not registered",
    await runnerExists(runner)
      ? `hook runner present at ${runner}`
      : `hook runner MISSING at ${runner}; every hook would fail silently`,
  ] };
}

/**
 * The paths an install would write, without writing them. Same helpers as the
 * install, so a dry run cannot drift from what actually happens.
 */
export function planKimiInstall({ home }) {
  return [
    { path: pluginPath(home), kind: "tree" },
    { path: configPath(home), kind: "merge" },
    { path: registryPath(home), kind: "merge" },
  ];
}
