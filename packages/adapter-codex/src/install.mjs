import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { removeTomlBlock, stripBlock, tomlString, writeHookShim, writeTomlBlock }
  from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const PLUGIN_NAME = "agents-can-communicate";

// The marketplace ACC owns. Registering a separate one rather than editing the
// user's keeps the two apart: uninstall removes a marketplace ACC created and
// never touches entries someone else put in theirs.
const MARKETPLACE = "acc-local";
const QUALIFIED = `${PLUGIN_NAME}@${MARKETPLACE}`;

const marketplacePath = root => path.join(root, ".agents", "plugins", "marketplace.json");
const pluginPath = (root, name = PLUGIN_NAME) => path.join(root, "plugins", name);
const configPath = codexHome => path.join(codexHome, "config.toml");
// Where `codex plugin add` leaves the copy it actually runs. All three
// components are ACC's own - the marketplace it created, the plugin name it
// chose, and the version in the manifest it ships - so ACC can write this copy
// itself rather than asking the user to run a command. Verified on 0.147.0:
// diffing the home around `codex plugin add` shows that copy is the only thing
// it does, and a real session against a cache ACC wrote fires every hook.
const cacheRoot = codexHome => path.join(codexHome, "plugins", "cache", MARKETPLACE);
const cachePath = codexHome => path.join(cacheRoot(codexHome), PLUGIN_NAME);
const cachedVersionPath = (codexHome, version) =>
  path.join(cachePath(codexHome), version);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

// Replace the bundle's placeholder command with the shim just written. The
// client copies an installed plugin into a cache of its own, so the command has
// to be absolute: a path relative to the bundle would not survive the copy.
const withShim = (wiring, shim) => ({ ...wiring, hooks: Object.fromEntries(
  Object.entries(wiring.hooks).map(([event, entries]) => [event, entries.map(entry => ({
    ...entry,
    hooks: entry.hooks.map(hook => ({ ...hook,
      command: `sh "${shim}" ${hook.command.split(" ").pop()}` })),
  }))])) });

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * The marketplace entry, in the shape this client's parser accepts.
 *
 * `plugins` is a sequence, not a map. A map is rejected outright - "invalid
 * type: map, expected a sequence" - and the client then fails to load the whole
 * file, so a marketplace ACC wrote incorrectly would take the user's own
 * plugins down with it. `authentication` accepts only ON_INSTALL or ON_USE.
 */
const entryFor = () => ({
  name: PLUGIN_NAME,
  source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
  policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" },
  category: "Coding",
});

/**
 * Place the plugin, publish it in a marketplace, and register both.
 *
 * Placing files is not installing. This client discovers plugins only through a
 * marketplace named in its own config, and runs only plugins enabled there, so
 * an install that writes files alone leaves a plugin the client never sees and
 * a hook that never runs - while reporting success.
 */
export async function installCodexPlugin({ home, agentsHome = home,
  codexHome = path.join(home, ".codex"), runner, node }) {
  const target = pluginPath(agentsHome);
  await rm(target, { recursive: true, force: true });
  await cp(bundle, target, { recursive: true });
  const shim = await writeHookShim({ dir: target, adapterId: "codex", runner, node });
  await writeJson(path.join(target, "hooks.json"),
    withShim(await readJson(path.join(bundle, "hooks.json"), { hooks: {} }), shim));

  const file = marketplacePath(agentsHome);
  const existing = await readJson(file, { name: MARKETPLACE,
    interface: { displayName: "Agents Can Communicate" }, plugins: [] });
  // Ownership is the entry's own name. Recording it as an extra key beside the
  // plugins - which is what this used to do - puts a nameless entry into a
  // sequence the client then tries to load.
  const others = (existing.plugins ?? []).filter(entry => entry.name !== PLUGIN_NAME);
  await writeJson(file, { ...existing, plugins: [...others, entryFor()] });

  const config = configPath(codexHome);
  // A marketplace declared twice makes this client refuse the whole config, and
  // then every plugin the user has stops working. If they registered it
  // themselves, say so rather than appending a duplicate table.
  const before = await readFile(config, "utf8").catch(() => "");
  if (stripBlock(before).includes(`[marketplaces.${MARKETPLACE}]`)) {
    throw new AccError(EXIT.CONFLICT,
      `marketplace ${MARKETPLACE} is already registered in this config; `
      + "remove it and install again", { config });
  }
  await writeTomlBlock(config, [
    `[marketplaces.${MARKETPLACE}]`,
    `source_type = "local"`,
    `source = ${tomlString(agentsHome)}`,
    "",
    `[plugins.${tomlString(QUALIFIED)}]`,
    "enabled = true",
  ]);

  // The client runs the cached copy, so this has to happen after the shim and
  // the rewritten hooks.json are in place.
  const { version } = await readJson(
    path.join(target, ".codex-plugin", "plugin.json"), { version: "0.0.0" });
  const cached = cachedVersionPath(codexHome, version);
  await rm(cached, { recursive: true, force: true });
  await cp(target, cached, { recursive: true });

  return { ok: true, changes: [target, file, config, cached],
    diagnostics: ["hooks require explicit trust in Codex before they run"] };
}

export async function uninstallCodexPlugin({ home, agentsHome = home,
  codexHome = path.join(home, ".codex") }) {
  const file = marketplacePath(agentsHome);
  const existing = await readJson(file, null);
  const changes = [];
  if (existing !== null) {
    const kept = (existing.plugins ?? []).filter(entry => entry.name !== PLUGIN_NAME);
    if (kept.length !== (existing.plugins ?? []).length) changes.push(PLUGIN_NAME);
    await writeJson(file, { ...existing, plugins: kept });
  }
  if (await removeTomlBlock(configPath(codexHome))) changes.push(configPath(codexHome));
  // The marketplace directory is ACC's too, so it goes rather than being left
  // behind empty.
  await rm(cacheRoot(codexHome), { recursive: true, force: true });
  await rm(pluginPath(agentsHome), { recursive: true, force: true });
  return { ok: true, changes, diagnostics: [] };
}

export async function detectCodex({ home, agentsHome = home,
  codexHome = path.join(home, ".codex") }) {
  const marketplace = await readJson(marketplacePath(agentsHome), null);
  const published = (marketplace?.plugins ?? []).some(entry => entry.name === PLUGIN_NAME);
  const config = await readFile(configPath(codexHome), "utf8").catch(() => "");
  const registered = config.includes(`[marketplaces.${MARKETPLACE}]`);
  const enabled = config.includes(`[plugins."${QUALIFIED}"]`);
  const cached = await stat(cachePath(codexHome)).then(() => true).catch(() => false);
  return { ok: true, changes: [], diagnostics: [
    published ? "acc plugin published in the marketplace" : "acc plugin not registered",
    registered && enabled
      ? "marketplace registered and plugin enabled"
      : "marketplace not registered with the client; no hook would run",
    // Publishing, registering and enabling are all necessary and still not
    // sufficient: hooks stay silent until the client copies the plugin into its
    // own cache. Only the client does that, so ACC names the command.
    cached
      ? "plugin installed in the client's cache"
      : `plugin not installed yet; run: codex plugin add ${QUALIFIED}`,
  ] };
}
