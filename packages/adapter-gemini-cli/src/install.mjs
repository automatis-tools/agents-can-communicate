import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { fileURLToPath } from "node:url";

import { acccreatedFile, bakeSkillCommand, blankJson, ownVersion, removeIfEmpty,
  removeInstalledTree,
  stampPluginVersion, writeForeignJson, writeHookShim }
  from "@agents-can-communicate/adapter-sdk";

const bundle = fileURLToPath(new URL("../extension", import.meta.url));
const EXTENSION_NAME = "agents-can-communicate";
const OWNER_PREFIX = "acc-";

const settingsPath = home => path.join(home, ".gemini", "settings.json");
const extensionPath = home => path.join(home, ".gemini", "extensions", EXTENSION_NAME);

/**
 * Read a client's own JSON, and say which file when it will not parse.
 *
 * A malformed config is the user's to fix, and the message they get has to name
 * it. `Unexpected end of JSON input` arrived with no path attached, from an
 * install that touches four clients' homes, and left them to guess which.
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

// Settings are the user's file, with their own hooks and their own formatting.
const writeJson = (file, value) => writeForeignJson(file, value,
  { readFile, writeFile, mkdir });

const isOurs = hook => typeof hook?.name === "string" && hook.name.startsWith(OWNER_PREFIX);

// Replace the bundle's placeholder command with the shim that was just written.
const withShim = (wiring, shim) => ({ hooks: Object.fromEntries(
  Object.entries(wiring.hooks).map(([event, entries]) => [event, entries.map(entry => ({
    ...entry,
    hooks: entry.hooks.map(hook => ({ ...hook,
      command: `sh "${shim}" ${hook.command.split(" ").pop()}` })),
  }))])) });

/**
 * Merge ACC's hook entries into the user's settings, keyed by the `name` field
 * this client supports. Ownership by name is what makes uninstall exact: a
 * user's own entry can carry an identical command string, and removing by
 * command would take theirs with ours.
 *
 * No environment variable is copied or persisted. The extension declares what
 * it needs; secrets stay where the user put them.
 */
export async function installGeminiExtension({ home, runner, node }) {
  // Read before writing: a settings file that will not parse must not be found
  // out after the extension tree is already on disk.
  const found = await readJson(settingsPath(home), null);
  const existing = found ?? {};

  const target = extensionPath(home);
  await rm(target, { recursive: true, force: true });
  await cp(bundle, target, { recursive: true });
  await stampPluginVersion({ file: path.join(target, "gemini-extension.json"),
    version: await ownVersion(import.meta.url), io: { readFile, writeFile } });
  // The bundle's hooks.json is the template the settings entries are built
  // from, not something to ship. This client loads an extension's own
  // hooks.json *in addition to* settings, so shipping it registered ACC
  // twice: once with the shim, and once with the literal placeholder
  // `acc-hook`, which is not on PATH. The client reported the second one
  // failing on every event while the first quietly did the work.
  await rm(path.join(target, "hooks", "hooks.json"), { force: true });
  // The skill ships with a placeholder where the command belongs: `acc` is
  // not on PATH everywhere, and an agent that cannot run it improvises.
  await bakeSkillCommand({ root: target, node });
  // This client offers no plugin-root variable in a hook command, so the shim's
  // absolute path is written in at install time.
  const shim = await writeHookShim({ dir: path.join(target, "hooks"),
    adapterId: "gemini_cli", runner, node });

  const ours = withShim(await readJson(path.join(bundle, "hooks", "hooks.json"),
    { hooks: {} }), shim);
  const file = settingsPath(home);
  const merged = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  // Recorded now: afterwards a settings file holding `{}` looks the same
  // whether ACC created it or the user did.
  if (found === null) merged["acc:createdFile"] = true;
  for (const [event, entries] of Object.entries(ours.hooks)) {
    const foreign = (merged.hooks[event] ?? [])
      .map(entry => ({ ...entry, hooks: (entry.hooks ?? []).filter(hook => !isOurs(hook)) }))
      .filter(entry => entry.hooks.length > 0);
    merged.hooks[event] = [...foreign, ...entries];
  }
  await writeJson(file, merged);
  return { ok: true, changes: [target, file], diagnostics: [] };
}

export async function uninstallGeminiExtension({ home, keep = [] }) {
  const file = settingsPath(home);
  const existing = await readJson(file, null);
  const changes = [];
  if (existing !== null) {
    const hooks = {};
    for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
      const kept = entries
        .map(entry => ({ ...entry, hooks: (entry.hooks ?? []).filter(hook => !isOurs(hook)) }))
        .filter(entry => entry.hooks.length > 0);
      if (kept.length > 0) hooks[event] = kept;
      else changes.push(event);
    }
    const next = { ...existing };
    if (Object.keys(hooks).length > 0) next.hooks = hooks;
    else delete next.hooks;
    delete next["acc:createdFile"];
    await writeJson(file, next);
  }
  await removeIfEmpty(settingsPath(home),
    { readFile, rm, isEmpty: blankJson(), created: acccreatedFile(existing) });

  await removeInstalledTree(extensionPath(home), keep);
  return { ok: true, changes, diagnostics: [] };
}

export async function detectGemini({ home }) {
  const existing = await readJson(settingsPath(home), null);
  const installed = Object.values(existing?.hooks ?? {})
    .some(entries => entries.some(entry => (entry.hooks ?? []).some(isOurs)));
  return { ok: true, changes: [],
    diagnostics: [installed ? "acc hooks registered" : "acc hooks not registered"] };
}

/**
 * The paths an install would write, without writing them. Same helpers as the
 * install, so a dry run cannot drift from what actually happens.
 */
export function planGeminiInstall({ home }) {
  return [
    { path: extensionPath(home), kind: "tree" },
    { path: settingsPath(home), kind: "merge" },
  ];
}
