import { cp, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bakeSkillCommand, blankJson, blankText, removeIfEmpty, removeInstalledTree,
  ownVersion, stampPluginVersion,
  removeTomlBlock, stripBlock, tomlString,
  writeForeignJson, writeHookShim, writeTomlBlock }
  from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const PLUGIN_NAME = "agents-can-communicate";

// The marketplace ACC owns, and its own root inside the agents home.
//
// Registering a separate one rather than joining the user's keeps the two
// apart. ACC used to write into `<home>/.agents/plugins/marketplace.json` -
// which is the marketplace this client discovers by itself, with no config
// entry at all, under whatever that manifest calls itself. So ACC merged its
// entry into someone else's marketplace and then enabled `…@acc-local`, an id
// this client never forms: `acc install` reported success and `codex plugin
// list` said `not installed`. Measured against Codex 0.147.0, then measured
// again to confirm a root of ACC's own is accepted and reported enabled.
const MARKETPLACE = "acc-local";
const QUALIFIED = `${PLUGIN_NAME}@${MARKETPLACE}`;

// A marketplace is a root holding `.agents/plugins/marketplace.json`, and every
// `source.path` in that manifest - `./plugins/<name>` - is resolved by this
// client against the *root*, not against the manifest's directory. Measured:
// `codex plugin list` prints the path it resolved, and for a plugin the user
// installed themselves it printed `<root>/plugins/x` from an entry spelled
// `./plugins/x`. The comment that used to be here said the opposite, and ACC
// wrote its tree two directories below where the client then looked.
//
// The root is under `.agents/` rather than the home itself: `<home>/plugins/`
// is where this client would put it, and nothing of ACC's belongs at the top of
// somebody's home.
const marketplaceRoot = agentsHome => path.join(agentsHome, ".agents", MARKETPLACE);
const marketplacePath = agentsHome =>
  path.join(marketplaceRoot(agentsHome), ".agents", "plugins", "marketplace.json");
const pluginPath = (agentsHome, name = PLUGIN_NAME) =>
  path.join(marketplaceRoot(agentsHome), "plugins", name);
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
/**
 * The table that lets an agent here record anything at all.
 *
 * This client sandboxes the shell commands a model runs to the workspace, and
 * ACC keeps its state outside every workspace on purpose - so an agent could
 * read the roster and write nothing: `acc claim`, `acc work`, `acc message` all
 * failed with `EPERM ... locks/writer.lock`. Measured with `codex exec`, which
 * is how an agent actually runs, and confirmed by watching the same commands
 * succeed once this root was declared.
 *
 * Left out when the user declares the table themselves. Declaring it twice is
 * what makes this client refuse the whole config, and their setting is theirs -
 * the diagnostic says what to add rather than adding it for them.
 */
const sandboxTable = (stateRoot, theirs) => {
  if (typeof stateRoot !== "string" || stateRoot === "") return [];
  if (theirs) return [];
  return ["", "[sandbox_workspace_write]",
    `writable_roots = [${tomlString(stateRoot)}]`];
};

// Every spelling TOML allows for the same table: the header, a sub-table
// header, a dotted key, and an inline table on one line. Missing one means ACC
// appends a second declaration - which is the duplicate this exists to avoid,
// and the client refuses the whole config over it.
const declaresSandbox = config =>
  /^\s*\[sandbox_workspace_write[\].]/m.test(config)
  || /^\s*sandbox_workspace_write\s*[.=]/m.test(config);

export async function installCodexPlugin({ home, agentsHome = home,
  codexHome = path.join(home, ".codex"), stateRoot, runner, node }) {
  // Read before writing, so a manifest that will not parse is found before a
  // plugin tree is laid down that nothing will then be able to remove.
  const existing = await readJson(marketplacePath(agentsHome), { name: MARKETPLACE,
    interface: { displayName: "Agents Can Communicate" }, plugins: [] });
  // The name in the manifest, which is the one this client forms plugin ids
  // from. ACC used its own regardless, so on a machine that already had a
  // marketplace at this root - discovered without any config entry, under
  // whatever its manifest calls itself - the id ACC enabled was one the client
  // never forms, and the plugin sat there listed and not installed.
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
  const theirSandbox = declaresSandbox(stripBlock(before));
  await writeTomlBlock(config, [
    `[marketplaces.${MARKETPLACE}]`,
    `source_type = "local"`,
    `source = ${tomlString(marketplaceRoot(agentsHome))}`,
    "",
    `[plugins.${tomlString(QUALIFIED)}]`,
    "enabled = true",
    ...sandboxTable(stateRoot, theirSandbox),
  ]);

  // The client runs the cached copy, so this has to happen after the shim and
  // the rewritten hooks.json are in place.
  // One version on this machine: the package's own. The shipped manifest carries
  // none, so nothing in the repository can fall out of step with it - which is
  // how every client came to report 0.1.6 while running 0.1.9. The copy the
  // client reads is stamped, so it says which ACC wrote it.
  const version = await ownVersion(import.meta.url);
  await stampPluginVersion({ file: path.join(target, ".codex-plugin", "plugin.json"),
    version, io: { readFile, writeFile } });
  const cached = cachedVersionPath(codexHome, version);
  await rm(cached, { recursive: true, force: true });
  await cp(target, cached, { recursive: true });

  // The plugin's own directory in the cache. Not the versioned one inside it,
  // which goes stale the moment the version changes - and not the marketplace
  // cache root above it, which belongs to whoever's marketplace this is: that
  // root holds every plugin installed from it, and removing it took a plugin
  // the user had installed themselves. Measured, on a real machine.
  //
  // The old comment here said the root was "what ACC owns", which was true only
  // while ACC invented its own marketplace name and so had a root to itself.
  // make the record stale the moment the plugin version changes.
  return { ok: true, changes: [target, file, config, cachePath(codexHome)],
    diagnostics: ["hooks require explicit trust in Codex before they run",
      ...(theirSandbox
        ? [`this config sets its own sandbox_workspace_write; add ${stateRoot} to `
          + "writable_roots, or an agent here can read the roster and record nothing"]
        : [])] };
}

/** Remove each directory that is empty, in the order given. */
async function removeEmptyDirs(directories) {
  for (const directory of directories) {
    await rmdir(directory).catch(() => {});
  }
}

/**
 * Drop the client's trust record for hooks that are about to stop existing.
 *
 * Scoped to tables whose key begins with ACC's own `plugin@marketplace:` - a
 * table belonging to any other plugin is the client's business and stays. The
 * file is rewritten only when something was found, so an install that never ran
 * here leaves the config byte for byte as it was.
 */
export async function removeHookTrust(file, prefix) {
  const before = await readFile(file, "utf8").catch(() => null);
  if (before === null || !before.includes(`hooks.state."${prefix}`)) return false;

  const lines = before.split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (header !== null) dropping = header[1].startsWith(`hooks.state."${prefix}`);
    if (dropping) continue;
    kept.push(line);
  }
  // A table's trailing blank line goes with it rather than piling up.
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  if (text === before) return false;
  await writeFile(file, text, "utf8");
  return true;
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
  // This client keeps its own record of which hook files it has trusted, one
  // table per hook, keyed by the plugin that declared them. ACC never writes
  // those - they are the client's bookkeeping about ACC - but once the plugin is
  // gone they name a thing that does not exist, five of them per install, and
  // nothing else will ever clear them. Verified inert first: a hook whose hash
  // no longer matches still runs, so this is tidiness rather than repair.
  if (await removeHookTrust(configPath(codexHome), `${PLUGIN_NAME}@${MARKETPLACE}:`)) {
    if (!changes.includes(configPath(codexHome))) changes.push(configPath(codexHome));
  }
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

  await removeInstalledTree(cachePath(codexHome), keep);
  await removeInstalledTree(pluginPath(agentsHome), keep);
  // The directories ACC made to hold those, once nothing is in them. They are
  // ACC's own - a marketplace root it created and the cache directory named
  // after it - and an empty one left behind is litter in a home that did not
  // have it. Anything the user put inside stops this: the directory is not
  // empty, and it stays.
  await removeEmptyDirs([
    path.join(marketplaceRoot(agentsHome), "plugins"),
    path.dirname(marketplacePath(agentsHome)),
    path.dirname(path.dirname(marketplacePath(agentsHome))),
    marketplaceRoot(agentsHome),
    cacheRoot(codexHome),
  ]);
  return { ok: true, changes, diagnostics: [] };
}

export async function detectCodex({ home, agentsHome = home,
  codexHome = path.join(home, ".codex") }) {
  const marketplace = await readJson(marketplacePath(agentsHome), null);
  const published = (marketplace?.plugins ?? []).some(entry => entry.name === PLUGIN_NAME);
  const config = await readFile(configPath(codexHome), "utf8").catch(() => "");
  const registered = config.includes(`[marketplaces.${MARKETPLACE}]`);
  const enabled = config.includes(`[plugins."${QUALIFIED}"]`);
  const cached = await stat(cachePath(codexHome))
    .then(() => true).catch(() => false);
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
    { path: cachePath(codexHome), kind: "tree" },
    { path: marketplacePath(agentsHome), kind: "merge" },
    { path: configPath(codexHome), kind: "merge" },
  ];
}
