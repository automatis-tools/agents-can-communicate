import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A stand-in for the `agy` binary, built from what 1.2.7 was captured doing -
 * never from its documentation, which the captures contradicted twice.
 *
 * - `plugin install <dir>` copies the whole directory to
 *   `<home>/.gemini/config/plugins/<name>/` and records it in
 *   `<home>/.gemini/config/import_manifest.json`; installing again overwrites.
 *   (fixtures/plugin-install-lifecycle-1.2.7.json)
 * - `plugin uninstall <name>` removes the directory and leaves the manifest
 *   behind as `{"imports": null}`, even when install created it.
 * - `-p /skills` lists every skill it discovered. A plugin's skill is named
 *   `<plugin>:<skill>`. An auto-imported plugin under
 *   `~/.gemini/antigravity-cli/plugins/` shadows a same-named one installed
 *   under `~/.gemini/config/plugins/`. (fixtures/plugin-name-collision-1.2.7.json)
 * - `-p /hooks` reports the `acc` namespace of the global hooks.json.
 *
 * Every call is recorded with the HOME it was given, because running the real
 * binary against the wrong home verifies the wrong machine.
 */
export function fakeAgy({ authenticated = true, failOn = [] } = {}) {
  const calls = [];
  const exists = async target => stat(target).then(() => true, () => false);
  const readJson = async (file, fallback) => JSON.parse(
    await readFile(file, "utf8").catch(() => JSON.stringify(fallback)));

  const skillsIn = async (root, plugin) => {
    const skills = path.join(root, "skills");
    const names = await readdir(skills).catch(() => []);
    return names.map(skill => ({ name: `${plugin}:${skill}`,
      path: path.join(skills, skill, "SKILL.md"), plugin, builtin: false,
      model_invocable: true }));
  };

  const run = async (args, { home }) => {
    calls.push({ args, home });
    if (failOn.some(prefix => args.join(" ").startsWith(prefix))) {
      throw new Error(`agy ${args.join(" ")} failed`);
    }
    const config = path.join(home, ".gemini", "config");
    const manifest = path.join(config, "import_manifest.json");
    if (args[0] === "plugin" && args[1] === "install") {
      const source = args[2];
      const { name } = await readJson(path.join(source, "plugin.json"), {});
      const target = path.join(config, "plugins", name);
      await rm(target, { recursive: true, force: true });
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
      const current = await readJson(manifest, { imports: [] });
      const imports = (current.imports ?? []).filter(entry => entry.name !== name);
      await writeFile(manifest, `${JSON.stringify({ imports: [...imports,
        { name, source: "antigravity", components: ["skills"] }] }, null, 2)}\n`);
      return { stdout: `  [ok]    ${name}\n` };
    }
    if (args[0] === "plugin" && args[1] === "uninstall") {
      const name = args[2];
      const target = path.join(config, "plugins", name);
      if (!await exists(target)) throw new Error(`plugin "${name}" is not installed`);
      await rm(target, { recursive: true, force: true });
      const current = await readJson(manifest, { imports: [] });
      const imports = (current.imports ?? []).filter(entry => entry.name !== name);
      // Exactly what 1.2.7 leaves: null, not an empty array, and the file stays.
      await writeFile(manifest, `${JSON.stringify({ imports: imports.length === 0
        ? null : imports }, null, 2)}\n`);
      return { stdout: `Uninstalled plugin "${name}"\n` };
    }
    if (args[0] === "-p") {
      if (!authenticated) {
        return { stdout: JSON.stringify({ status: "ERROR",
          error: "authentication failed or timed out" }) };
      }
      if (args[1] === "/skills") {
        const imported = path.join(home, ".gemini", "antigravity-cli", "plugins");
        const installed = path.join(config, "plugins");
        const found = new Map();
        // Imported first, so a same-named installed plugin is shadowed.
        for (const [root, names] of [[imported, await readdir(imported).catch(() => [])],
          [installed, await readdir(installed).catch(() => [])]]) {
          for (const plugin of names) {
            for (const skill of await skillsIn(path.join(root, plugin), plugin)) {
              if (!found.has(skill.name)) found.set(skill.name, skill);
            }
          }
        }
        return { stdout: JSON.stringify({ status: "SUCCESS",
          command: { name: "skills", data: { skills: [...found.values()] } } }) };
      }
      if (args[1] === "/hooks") {
        const hooks = await readJson(path.join(config, "hooks.json"), {});
        const acc = hooks.acc;
        return { stdout: JSON.stringify({ status: "SUCCESS", command: { name: "hooks",
          data: { hooks: acc === undefined ? [] : [{ name: "acc", enabled: true,
            source: path.join(config, "hooks.json"),
            actions: Object.keys(acc).map(event => ({ event })) }] } } }) };
      }
    }
    throw new Error(`the fake agy does not know: ${args.join(" ")}`);
  };
  return { run, calls };
}
