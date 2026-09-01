import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { bakeSkillCommand, removeInstalledTree, writeHookShim }
  from "@agents-can-communicate/adapter-sdk";

const bundle = fileURLToPath(new URL("../plugin", import.meta.url));
const HOOKS_NAME = "acc.json";
const SHIM_NAME = "acc-hook.sh";

/** This client's own directory. Never the user's home, never ~/.claude. */
export const grokHomeOf = context =>
  context.grokHome ?? path.join(context.home, ".grok");

export const hooksFile = home => path.join(home, "hooks", HOOKS_NAME);
export const shimPath = home => path.join(home, "hooks", SHIM_NAME);
export const skillPath = home => path.join(home, "skills", "acc");

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
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === text) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

// This client has no plugin-root variable we rely on. GROK_PLUGIN_ROOT exists
// for plugins; we install into ~/.grok/hooks, which is always trusted and does
// not need [plugins].enabled. The shim's absolute path is written in at install
// time, the same lesson Codex taught: a relative hook command fails silently.
const withShim = (wiring, shim) => ({
  description: wiring.description,
  hooks: Object.fromEntries(Object.entries(wiring.hooks).map(([event, entries]) =>
    [event, entries.map(entry => ({
      ...entry,
      hooks: entry.hooks.map(hook => ({ ...hook,
        command: `sh "${shim}" ${hook.command.split(" ").pop()}` })),
    }))])),
});

export async function installGrokHooks({ grokHome, home, runner, node }) {
  const root = grokHome ?? grokHomeOf({ home, grokHome });
  const template = await readJson(path.join(bundle, "hooks", "hooks.json"), { hooks: {} });
  const shim = await writeHookShim({ dir: path.join(root, "hooks"), adapterId: "grok",
    runner, node, name: SHIM_NAME });

  const skills = skillPath(root);
  await rm(skills, { recursive: true, force: true });
  await mkdir(path.dirname(skills), { recursive: true });
  await cp(path.join(bundle, "skills", "acc"), skills, { recursive: true });
  await bakeSkillCommand({ root: skills, node });

  await writeJson(hooksFile(root), withShim(template, shim));
  return { ok: true, changes: [hooksFile(root), shim, skills], diagnostics: [] };
}

export async function uninstallGrokHooks({ grokHome, home, keep = [] }) {
  const root = grokHome ?? grokHomeOf({ home, grokHome });
  const changes = [];
  for (const target of [hooksFile(root), shimPath(root), skillPath(root)]) {
    if (await removeInstalledTree(target, keep)) changes.push(target);
  }
  return { ok: true, changes, diagnostics: [] };
}

export async function detectGrok({ grokHome, home }) {
  const root = grokHome ?? grokHomeOf({ home, grokHome });
  const wired = await readJson(hooksFile(root), null);
  const installed = typeof wired?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command
    === "string"
    && wired.hooks.SessionStart[0].hooks[0].command.includes(SHIM_NAME);
  return { ok: true, changes: [],
    diagnostics: [installed ? "acc hooks registered" : "acc hooks not registered"] };
}

export function planGrokInstall(context) {
  const root = grokHomeOf(context);
  return [
    { path: hooksFile(root), kind: "tree" },
    { path: shimPath(root), kind: "tree" },
    { path: skillPath(root), kind: "tree" },
  ];
}
