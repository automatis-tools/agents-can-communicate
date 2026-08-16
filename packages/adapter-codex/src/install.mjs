import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeOwnedConfig, ownedKeys, removeOwnedConfig }
  from "@agents-can-communicate/adapter-sdk";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const PLUGIN_NAME = "agents-can-communicate";

const marketplacePath = home => path.join(home, ".agents", "plugins", "marketplace.json");
const pluginPath = (home, name = PLUGIN_NAME) => path.join(home, "plugins", name);

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
 * Place the plugin and register it in the personal marketplace.
 *
 * Codex installs plugins from a marketplace snapshot rather than by discovering
 * a directory, so writing the files alone would leave a plugin the client never
 * sees. Existing marketplace entries are preserved and the ACC entry is
 * recorded as owned, so uninstall removes exactly what was added.
 */
export async function installCodexPlugin({ home, agentsHome = home }) {
  const target = pluginPath(home);
  await rm(target, { recursive: true, force: true });
  await cp(bundle, target, { recursive: true });

  const file = marketplacePath(agentsHome);
  const existing = await readJson(file, { name: "personal", plugins: {} });
  const merged = mergeOwnedConfig(existing.plugins ?? {},
    { [PLUGIN_NAME]: { source: path.relative(path.dirname(file), target) } });
  await writeJson(file, { ...existing, plugins: merged });

  return { ok: true, changes: [target, file],
    diagnostics: ["hooks require explicit trust in Codex before they run"] };
}

export async function uninstallCodexPlugin({ home, agentsHome = home }) {
  const file = marketplacePath(agentsHome);
  const existing = await readJson(file, null);
  const changes = [];
  if (existing !== null) {
    const removed = ownedKeys(existing.plugins ?? {});
    await writeJson(file, { ...existing, plugins: removeOwnedConfig(existing.plugins ?? {}) });
    changes.push(...removed);
  }
  await rm(pluginPath(home), { recursive: true, force: true });
  return { ok: true, changes, diagnostics: [] };
}

export async function detectCodex({ home, agentsHome = home }) {
  const marketplace = await readJson(marketplacePath(agentsHome), null);
  const installed = ownedKeys(marketplace?.plugins ?? {}).includes(PLUGIN_NAME);
  return { ok: true, changes: [],
    diagnostics: [installed ? "acc plugin registered" : "acc plugin not registered"] };
}
