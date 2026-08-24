import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../../packages/", import.meta.url));

/**
 * The version a client caches a plugin under.
 *
 * Read from the manifest that ships it rather than written out. Every one of
 * these paths was spelled `0.0.0` by hand, and the first version bump broke five
 * tests that were describing a real behaviour perfectly well.
 */
export async function pluginVersion(manifest) {
  return JSON.parse(await readFile(path.join(packages, manifest), "utf8")).version;
}

export const CLAUDE_PLUGIN = "adapter-claude-code/plugin/.claude-plugin/plugin.json";
export const CODEX_PLUGIN = "adapter-codex/plugin/.codex-plugin/plugin.json";
export const KIMI_PLUGIN = "adapter-kimi/plugin/.kimi-plugin/plugin.json";
