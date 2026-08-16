import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeOwnedConfig, ownedKeys, removeOwnedConfig, writeHookShim }
  from "@agents-can-communicate/adapter-sdk";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const PLUGIN_NAME = "agents-can-communicate";

const settingsPath = configDir => path.join(configDir, "settings.json");
const pluginPath = configDir => path.join(configDir, "plugins", PLUGIN_NAME);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Merge ACC's plugin registration into the user's settings without disturbing
 * anything else. Ownership is recorded, so uninstall removes exactly what was
 * added rather than guessing by shape - a user's own PreToolUse hook can look
 * very much like ours.
 */
export async function installClaudePlugin({ configDir, runner, node }) {
  const target = pluginPath(configDir);
  await rm(target, { recursive: true, force: true });
  await cp(bundle, target, { recursive: true });
  // The bundle's hooks.json names this script; until now nothing wrote it, so
  // every hook resolved to a command that does not exist and failed silently.
  await writeHookShim({ dir: path.join(target, "hooks"), adapterId: "claude_code",
    runner, node });

  const file = settingsPath(configDir);
  const existing = await readJson(file, {});
  await writeJson(file, mergeOwnedConfig(existing, { accPlugins: [target] }));
  return { ok: true, changes: [target, file], diagnostics: [] };
}

export async function uninstallClaudePlugin({ configDir }) {
  const file = settingsPath(configDir);
  const existing = await readJson(file, null);
  const changes = [];
  if (existing !== null) {
    changes.push(...ownedKeys(existing));
    await writeJson(file, removeOwnedConfig(existing));
  }
  await rm(pluginPath(configDir), { recursive: true, force: true });
  return { ok: true, changes, diagnostics: [] };
}

export async function detectClaude({ configDir }) {
  const existing = await readJson(settingsPath(configDir), null);
  const installed = ownedKeys(existing ?? {}).includes("accPlugins");
  return { ok: true, changes: [],
    diagnostics: [installed ? "acc plugin registered" : "acc plugin not registered"] };
}
