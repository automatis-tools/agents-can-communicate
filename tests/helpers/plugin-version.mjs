import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The version a client caches a plugin under.
 *
 * Read from the package, because that is now the only place it exists. It used
 * to be a literal in each plugin manifest, and this helper read it from there -
 * so the tests followed the literal wherever it went and could not see it drift.
 * It drifted: three releases after 0.1.6 the package was 0.1.9 while every
 * client had cached, listed and reported 0.1.6.
 *
 * The argument is kept so callers still say which plugin they mean; every one of
 * them is versioned with the package.
 */
export async function pluginVersion(_manifest) {
  return JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version;
}

export const CLAUDE_PLUGIN = "adapter-claude-code/plugin/.claude-plugin/plugin.json";
export const CODEX_PLUGIN = "adapter-codex/plugin/.codex-plugin/plugin.json";
export const KIMI_PLUGIN = "adapter-kimi/plugin/.kimi-plugin/plugin.json";
