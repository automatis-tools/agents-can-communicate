import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bakeSkillCommand, blankJson, blankText, removeIfEmpty, removeInstalledTree,
  removeTomlBlock, stripBlock, tomlString,
  writeForeignJson, writeHookShim, writeTomlBlock }
  from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const PLUGIN_NAME = "agents-can-communicate";

// The marketplace ACC owns. Registering a separate one rather than editing the
// user's keeps the two apart: uninstall removes a marketplace ACC created and
// never touches entries someone else put in theirs.
const MARKETPLACE = "acc-local";
const QUALIFIED = `${PLUGIN_NAME}@${MARKETPLACE}`;

// A marketplace is a directory whose manifest sits at
// `<root>/.agents/plugins/marketplace.json`, and every `source.path` in that
// manifest is relative to the manifest's own directory - `./plugins/<name>`,
// as the client's own entries are written. Resolving the plugin from `root`
// instead put the files two levels above where the manifest pointed, so the
// entry named a directory that did not exist and the client loaded nothing.
const marketplaceDir = root => path.join(root, ".agents", "plugins");
const marketplacePath = root => path.join(marketplaceDir(root), "marketplace.json");
const pluginPath = (root, name = PLUGIN_NAME) =>
  path.join(marketplaceDir(root), "plugins", name);
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

// The marketplace manifest is the user's: their own plugins are listed beside
// ACC's. Re-emitting it in ACC's style changed bytes nobody asked to change.
const writeMarketplace = (file, value) =>
  writeForeignJson(file, value, { readFile, writeFile, mkdir });

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
  // Read before writing, so a manifest that will not parse is found before a
  // plugin tree is laid down that nothing will then be able to remove.
  const existing = await readJson(marketplacePath(agentsHome), { name: MARKETPLACE,
    interface: { displayName: "Agents Can Communicate" }, plugins: [] });
  const before = await readFile(configPath(codexHome), "utf8").catch(() => "");

  const target = pluginPath(agentsHome);
  await rm(target, { recursive: true, force: true });
  await cp(bundle, target, { recursive: true });
  // The skill ships with a placeholder where the command belongs: `acc` is
  // not on PATH everywhere, and an agent that cannot run it improvises.
  await bakeSkillCommand({ root: target, node });
  const shim = await writeHookShim({ dir: target, adapterId: "codex", runner, node });
  await writeJson(path.join(target, "hooks.json"),
    withShim(await readJson(path.join(bundle, "hooks.json"), { hooks: {} }), shim));

  const file = marketplacePath(agentsHome);
  // Ownership is the entry's own name. Recording it as an extra key beside the
  // plugins - which is what this used to do - puts a nameless entry into a
  // sequence the client then tries to load.
  const others = (existing.plugins ?? []).filter(entry => entry.name !== PLUGIN_NAME);
  await writeMarketplace(file, { ...existing, plugins: [...others, entryFor()] });

  const config = configPath(codexHome);
  // A marketplace declared twice makes this client refuse the whole config, and
  // then every plugin the user has stops working. If they registered it
  // themselves, say so rather than appending a duplicate table.
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

  // The cache *root* rather than the versioned directory inside it: that is
  // what ACC owns and what uninstall removes, and reporting the version would
  // make the record stale the moment the plugin version changes.
  return { ok: true, changes: [target, file, config, cacheRoot(codexHome)],
    diagnostics: ["hooks require explicit trust in Codex before they run"] };
}

export async function uninstallCodexPlugin({ home, agentsHome = home,
  codexHome = path.join(home, ".codex"), keep = [] }) {
  const file = marketplacePath(agentsHome);
  const existing = await readJson(file, null);
  const changes = [];
  if (existing !== null) {
    const kept = (existing.plugins ?? []).filter(entry => entry.name !== PLUGIN_NAME);
    if (kept.length !== (existing.plugins ?? []).length) changes.push(PLUGIN_NAME);
    await writeMarketplace(file, { ...existing, plugins: kept });
  }
  if (await removeTomlBlock(configPath(codexHome))) changes.push(configPath(codexHome));
  // The marketplace directory is ACC's too, so it goes rather than being left
  // behind empty.
  // A blank TOML config and an absent one are the same to this client, and a
  // file with nothing in it holds nothing to lose - so no record of who created
  // it is needed here, unlike the JSON settings where `{}` can be a container
  // the user made.
  await removeIfEmpty(configPath(codexHome), { readFile, rm, isEmpty: blankText });
  // The manifest goes only when what is left is ACC's own marketplace with no
  // plugins in it. A manifest naming someone else's marketplace is theirs, empty
  // or not.
  await removeIfEmpty(marketplacePath(agentsHome), { readFile, rm,
    isEmpty: text => {
      const value = JSON.parse(text);
      return value?.name === MARKETPLACE && (value.plugins ?? []).length === 0;
    } });

  await removeInstalledTree(cacheRoot(codexHome), keep);
  await removeInstalledTree(pluginPath(agentsHome), keep);
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

/**
 * The paths an install would write, without writing them.
 *
 * Derived from the same helpers the install itself uses, so `--dry-run` cannot
 * describe one thing while install does another. A conformance test compares
 * this against what install actually reports changing.
 */
export function planCodexInstall({ home, agentsHome = home,
  codexHome = path.join(home, ".codex") }) {
  return [
    { path: pluginPath(agentsHome), kind: "tree" },
    { path: cacheRoot(codexHome), kind: "tree" },
    { path: marketplacePath(agentsHome), kind: "merge" },
    { path: configPath(codexHome), kind: "merge" },
  ];
}
