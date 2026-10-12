import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const repo = path.resolve(import.meta.dirname, "..", "..");

export const ADAPTER_PACKAGES = Object.freeze(["adapter-antigravity", "adapter-claude-code",
  "adapter-codex", "adapter-gemini-cli", "adapter-grok", "adapter-kimi"]);
export const adapterPackage = adapterId => `adapter-${adapterId.replaceAll("_", "-")}`;

/**
 * Every module one ACC process loaded, as file URLs with forward slashes. The
 * process runs from this checkout with its own data home, so no installed
 * runtime is selected in its place; `from(pkg)` lists one package's modules.
 */
export async function loadedModules(t, args, { stdin = "", cwd = repo } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-loads-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const list = path.join(home, "loaded.json");
  const hooks = path.join(home, "count.mjs");
  await writeFile(hooks, `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
process.on("exit", () => writeFileSync(${JSON.stringify(list)}, JSON.stringify(loaded)));
`);
  const pending = run(process.execPath, ["--import", pathToFileURL(hooks).href, ...args],
    { cwd, env: { ...process.env, ACC_DATA_HOME: path.join(home, "data") }, timeout: 60_000 });
  pending.child.stdin.end(stdin);
  await pending.catch(error => error);
  const loaded = JSON.parse(await readFile(list, "utf8")).map(url => url.replaceAll("\\", "/"));
  return { loaded, from: pkg => loaded.filter(url => url.includes(`/packages/${pkg}/`)) };
}
