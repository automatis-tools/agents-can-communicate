import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultIndicator, shellQuote, shortPath, windowsHookCommand, writeForeignJson }
  from "@agents-can-communicate/adapter-sdk";
import { agySettingsPath } from "./allow-rule.mjs";

const io = { readFile, writeFile, mkdir };
const load = async file => {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const markerPath = ({ dataHome, home }) => path.join(dataHome ?? path.join(home, ".gemini", "config"),
  "acc", "adapter-antigravity", "indicator.json");

/** Own only the wrapper command and the fields ACC actually changed. A later
 * user edit wins; the original status line is restored only where still ours. */
export async function configureIndicator(context, enabled) {
  const file = agySettingsPath(context.home), marker = markerPath(context);
  const saved = await load(marker);
  if (!enabled && !saved) return [];
  const existing = await load(file);
  if (saved && (saved.schemaVersion !== 1 || typeof saved.installed?.command !== "string"
    || !Array.isArray(saved.owned) || !saved.owned.every(key => typeof key === "string"))) {
    throw new Error("ACC status-line ownership is invalid; keep the user's settings and run acc doctor");
  }
  if (!enabled) {
    if (!saved) return [];
    if (existing?.statusLine?.command === saved.installed.command) {
      const current = { ...existing.statusLine };
      for (const key of saved.owned) {
        const value = saved.installed[key];
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) continue;
        if (Object.hasOwn(saved.previous ?? {}, key)) current[key] = saved.previous[key];
        else delete current[key];
      }
      const next = { ...existing };
      if (Object.keys(current).length) next.statusLine = current;
      else if (saved.previous !== null) next.statusLine = saved.previous;
      else delete next.statusLine;
      if (saved.createdFile && Object.keys(next).length === 0) await rm(file, { force: true });
      else await writeForeignJson(file, next, io);
    }
    await rm(marker, { force: true });
    return [file];
  }
  const ours = saved && existing?.statusLine?.command === saved.installed.command;
  const previous = ours ? saved.previous : existing?.statusLine ?? null;
  if (previous !== null && (previous.type !== "command" || typeof previous.command !== "string")) {
    throw new Error("ACC cannot compose this statusLine type; keep it and configure the indicator manually");
  }
  const node = context.node ?? process.execPath;
  const indicator = context.indicatorRunner ?? defaultIndicator();
  // Each path is one shell argument. The user's old shell program stays in a
  // JSON record; interpolating it into this command would change its quoting.
  let command;
  if ((context.hostPlatform ?? process.platform) === "win32") {
    const shim = path.join(context.home, ".gemini", "config", "acc", "indicator.mjs");
    await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(shim, `import { spawnSync } from "node:child_process";\n`
      + `const child = spawnSync(${JSON.stringify(node)}, ${JSON.stringify([indicator,
        "--adapter", "antigravity", "--previous", marker])}, {stdio:"inherit",windowsHide:true});\n`
      + `process.exitCode = child.status ?? 0;\n`);
    command = windowsHookCommand("unquoted", { node, shim: await shortPath(shim), args: [] }).trimEnd();
  } else command = [node, indicator, "--adapter", "antigravity", "--previous", marker]
    .map(shellQuote).join(" ");
  const installed = ours ? { ...existing.statusLine, command }
    : { ...previous, type: "command", command, enabled: true,
      stack_with_default: previous?.stack_with_default ?? true };
  const owned = ours ? saved.owned.filter(key =>
    JSON.stringify(existing.statusLine[key]) === JSON.stringify(saved.installed[key]))
    : Object.keys(installed).filter(key => JSON.stringify(installed[key]) !== JSON.stringify(previous?.[key]));
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, previous, installed, owned,
    createdFile: saved?.createdFile ?? existing === null }) + "\n");
  await writeForeignJson(file, { ...existing, statusLine: installed }, io);
  return [file];
}
