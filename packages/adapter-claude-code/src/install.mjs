import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { fileURLToPath } from "node:url";

import { acccreatedFile, bakeSkillCommand, blankJson, defaultBootstrap, defaultChannel,
  mergeOwnedEntries, ownedEntries,
  keepOnlyVersion, ownVersion, stampPluginVersion,
  removeIfEmpty,
  removeInstalledTree,
  removeOwnedEntries, writeForeignJson, writeHookShim }
  from "@agents-can-communicate/adapter-sdk";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const manifest = fileURLToPath(new URL("../plugin/.claude-plugin/plugin.json",
  import.meta.url));

const PLUGIN_NAME = "agents-can-communicate";
const MARKETPLACE = "acc-local";
const QUALIFIED = `${PLUGIN_NAME}@${MARKETPLACE}`;

/**
 * How this client actually installs a plugin.
 *
 * The previous version wrote a settings key called `accPlugins` and stopped.
 * There is no such setting: the client never loaded the plugin, no hook ever
 * fired, and no session attached - on any machine. It looked installed from
 * every direction, including `acc doctor`.
 *
 * Measured by running the client's own commands against a home and diffing it:
 *
 *   claude plugin marketplace add <dir>
 *   claude plugin install agents-can-communicate@acc-local --scope user
 *
 * Four things result, and all four are needed:
 *
 *   plugins/known_marketplaces.json   the marketplace, sourced from a directory
 *   plugins/installed_plugins.json    version 2, one entry per scope
 *   plugins/cache/<m>/<p>/<version>/  the copy the client runs from
 *   settings.json                     extraKnownMarketplaces + enabledPlugins
 *
 * Verified by registering it this way on a real machine: a `claude -p` run with
 * nothing about ACC in the prompt attached a session by itself.
 */
const settingsPath = configDir => path.join(configDir, "settings.json");
const pluginsDir = configDir => path.join(configDir, "plugins");
const marketplaceDir = configDir => path.join(pluginsDir(configDir), "marketplaces",
  MARKETPLACE);
const sourceDir = configDir => path.join(marketplaceDir(configDir), PLUGIN_NAME);
const marketplaceFile = configDir => path.join(marketplaceDir(configDir),
  ".claude-plugin", "marketplace.json");
const knownMarketplacesPath = configDir =>
  path.join(pluginsDir(configDir), "known_marketplaces.json");
const installedPluginsPath = configDir =>
  path.join(pluginsDir(configDir), "installed_plugins.json");
const cacheRoot = configDir => path.join(pluginsDir(configDir), "cache", MARKETPLACE);
const cachePath = (configDir, version) =>
  path.join(cacheRoot(configDir), PLUGIN_NAME, version);

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

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Write a registry the client owns, in the client's own shape.
 *
 * Measured: it writes these with two-space indent and **no** trailing newline.
 * Adding one made uninstall leave a one-byte difference in a file ACC had only
 * borrowed - the content restored exactly and the bytes did not, which is the
 * promise this tool makes about other people's files.
 *
 * Unchanged content is not rewritten at all, so a no-op install touches nothing.
 */
const writeClientJson = async (file, value) => {
  const text = JSON.stringify(value, null, 2);
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === text) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

// Settings are the user's own file. The two registries above are the client's
// and keep the convention measured from it; this one keeps whatever the user
// has.
const writeSettings = (file, value) =>
  writeForeignJson(file, value, { readFile, writeFile, mkdir });

/**
 * Put a registry back, or take it away if ACC is all that was ever in it.
 *
 * These two files exist because a plugin was installed. Removing the last entry
 * and leaving `{}` behind is litter in a home that had neither file before -
 * measured: an uninstall left both, holding nothing. An empty registry and an
 * absent one mean the same thing to this client, which defaults to exactly what
 * removing the entry produced.
 */
const writeRegistry = async (file, value, remaining) => {
  if (remaining > 0) return writeClientJson(file, value);
  return rm(file, { force: true });
};

// One version on this machine: the package's own. The shipped manifest carries
// none, so there is nothing in the repository to fall out of step.
const pluginVersion = async () => ownVersion(import.meta.url);

/** The marketplace manifest, in the shape the client's own directory sources use. */
const marketplaceManifest = () => ({
  name: MARKETPLACE,
  owner: { name: PLUGIN_NAME },
  metadata: { description: "Local ACC coordination plugin", version: "1.0.0" },
  plugins: [{
    name: PLUGIN_NAME,
    source: `./${PLUGIN_NAME}`,
    description: "Coordination between AI coding agents sharing a project",
    category: "productivity",
  }],
});

// The channel MCP entry Claude Code loads only when the session is started with
// the captured development-channel flag. Written with the pinned Node and the
// installed Channel binary, so the generated file carries no repository path;
// removed entirely for a non-live install so a plain launch spawns nothing.
const mcpPath = target => path.join(target, ".mcp.json");
async function writeChannelMcp(target, { node, channel }) {
  await writeJson(mcpPath(target), { mcpServers: { "acc-channel": {
    command: node, args: [channel] } } });
}

/** A plugin tree with the shim written and the skill's command baked in. */
async function layOutPlugin(target, { runner, node, channel, live }) {
  await rm(target, { recursive: true, force: true });
  await cp(bundle, target, { recursive: true });
  // The bundle ships a placeholder .mcp.json; the real one is written only for a
  // live install, and a non-live tree carries none.
  await rm(mcpPath(target), { force: true });
  if (live) await writeChannelMcp(target, { node, channel });
  // The skill ships with a placeholder where the command belongs: `acc` is not
  // on PATH everywhere, and an agent that cannot run it improvises.
  await bakeSkillCommand({ root: target, node });
  // The bundle's hooks.json names this script, and nothing else writes it.
  await writeHookShim({ dir: path.join(target, "hooks"), adapterId: "claude_code",
    runner, node });
  // The copy the client reads says which ACC wrote it. The shipped manifest
  // carries no version, so there is nothing in the repository to fall out of
  // step - which is how every client came to report 0.1.6 while running 0.1.9.
  await stampPluginVersion({ file: path.join(target, ".claude-plugin", "plugin.json"),
    version: await pluginVersion(), io: { readFile, writeFile } });
}

export async function installClaudePlugin({ configDir, runner, node = process.execPath,
  channel = defaultChannel(), livePolicy = "off", now = new Date() }) {
  const live = livePolicy === "actionable" || livePolicy === "all";
  // Everything this will merge into, read before a byte is written. A settings
  // file that will not parse used to be discovered after the plugin tree was
  // already on disk, and the install then failed with nineteen files left
  // behind, no ownership recorded, and an uninstall that hit the same file and
  // refused. What the user had to do about it was delete a directory by hand
  // that nothing had told them the name of.
  const settings = await readJson(settingsPath(configDir), null);
  const known = await readJson(knownMarketplacesPath(configDir), {});
  const installed = await readJson(installedPluginsPath(configDir),
    { version: 2, plugins: {} });

  const version = await pluginVersion();
  const stamp = now.toISOString();
  const source = sourceDir(configDir);
  const cached = cachePath(configDir, version);

  await layOutPlugin(source, { runner, node, channel, live });
  await writeJson(marketplaceFile(configDir), marketplaceManifest());
  // The copy the client runs from. Written here rather than asking the user to
  // run `claude plugin install`, exactly as the Codex adapter does, because the
  // command's only effect is this copy plus the two registry entries below.
  await layOutPlugin(cached, { runner, node, channel, live });
  // One copy, the one just written. A client caches a plugin under its version,
  // so every upgrade would otherwise leave the previous release's tree beside
  // this one - invisible while the version never moved, three deep once it did.
  await keepOnlyVersion({ root: path.dirname(cached), version,
    io: { readdir, rm } });

  await writeClientJson(knownMarketplacesPath(configDir), {
    ...known,
    [MARKETPLACE]: {
      source: { source: "directory", path: marketplaceDir(configDir) },
      installLocation: marketplaceDir(configDir),
      lastUpdated: known[MARKETPLACE]?.lastUpdated ?? stamp,
    },
  });

  // A re-install of the same version from the same path is not an event, and
  // stamping it moved bytes in a file ACC only borrows. The comment above
  // promised a no-op install touched nothing; the timestamps made that false.
  const [recorded] = installed.plugins?.[QUALIFIED] ?? [];
  const unchanged = recorded?.installPath === cached && recorded?.version === version;
  await writeClientJson(installedPluginsPath(configDir), {
    ...installed,
    version: 2,
    plugins: {
      ...installed.plugins,
      [QUALIFIED]: [unchanged ? recorded : { scope: "user", installPath: cached, version,
        installedAt: recorded?.installedAt ?? stamp, lastUpdated: stamp }],
    },
  });

  const file = settingsPath(configDir);
  const existing = settings;
  const createdFile = settings === null;
  // Entry-level ownership: `enabledPlugins` holds every plugin the user has, so
  // taking the whole key would destroy them and handing it back on uninstall
  // would destroy them again.
  await writeSettings(file, mergeOwnedEntries(existing ?? {}, {
    extraKnownMarketplaces: {
      [MARKETPLACE]: { source: { source: "directory", path: marketplaceDir(configDir) } },
    },
    enabledPlugins: { [QUALIFIED]: true },
  }, { createdFile }));

  return { ok: true,
    changes: [source, cached, marketplaceFile(configDir),
      knownMarketplacesPath(configDir), installedPluginsPath(configDir), file,
      ...(live ? [mcpPath(source), mcpPath(cached)] : [])],
    diagnostics: live
      ? ["native channel wired; Claude's experimental development-channel warning still applies"]
      : [] };
}

export async function uninstallClaudePlugin({ configDir, keep = [] }) {
  const changes = [];
  const file = settingsPath(configDir);
  const settings = await readJson(file, null);
  if (settings !== null) {
    changes.push(...ownedEntries(settings).map(pair => pair.join("/")));
    await writeSettings(file, removeOwnedEntries(settings));
  }

  // The registries belong to the client. Only ACC's own entry is taken out.
  const known = await readJson(knownMarketplacesPath(configDir), null);
  if (known !== null && Object.hasOwn(known, MARKETPLACE)) {
    const { [MARKETPLACE]: _removed, ...rest } = known;
    await writeRegistry(knownMarketplacesPath(configDir), rest, Object.keys(rest).length);
    changes.push(MARKETPLACE);
  }
  const installed = await readJson(installedPluginsPath(configDir), null);
  if (installed !== null && Object.hasOwn(installed.plugins ?? {}, QUALIFIED)) {
    const { [QUALIFIED]: _gone, ...rest } = installed.plugins;
    await writeRegistry(installedPluginsPath(configDir), { ...installed, plugins: rest },
      Object.keys(rest).length);
    changes.push(QUALIFIED);
  }

  // Only if ACC made it. A settings file holding `{}` looks the same whether
  // ACC created it or the user did, which is why the install recorded it.
  await removeIfEmpty(settingsPath(configDir),
    { readFile, rm, isEmpty: blankJson(), created: acccreatedFile(settings) });

  await removeInstalledTree(cacheRoot(configDir), keep);
  await removeInstalledTree(sourceDir(configDir), keep);
  await removeInstalledTree(marketplaceDir(configDir), keep);
  return { ok: true, changes, diagnostics: [] };
}

export async function detectClaude({ configDir }) {
  const settings = await readJson(settingsPath(configDir), null);
  const enabled = settings?.enabledPlugins?.[QUALIFIED] === true;
  const registered = Object.hasOwn(
    (await readJson(installedPluginsPath(configDir), { plugins: {} })).plugins ?? {},
    QUALIFIED);
  return { ok: true, changes: [],
    diagnostics: [enabled && registered
      ? "acc plugin registered and enabled"
      : "acc plugin not registered"] };
}

/**
 * The paths an install would write, without writing them. Same helpers as the
 * install, so a dry run cannot drift from what actually happens.
 */
export function planClaudeInstall({ configDir }) {
  return [
    { path: marketplaceDir(configDir), kind: "tree" },
    { path: cacheRoot(configDir), kind: "tree" },
    { path: knownMarketplacesPath(configDir), kind: "merge" },
    { path: installedPluginsPath(configDir), kind: "merge" },
    { path: settingsPath(configDir), kind: "merge" },
  ];
}
