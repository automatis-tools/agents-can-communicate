// Ask the selected Windows npm shim, never a neighboring npm installation.
// Only this fixed query reaches cmd; validation data stays direct Node argv.
import { statSync } from "node:fs";
import { chmod, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { terminationFailure } from "./push-process-tree.mjs";

const query = "npm --version --offline --update-notifier=false --logs-max=0 --color=false";
const limit = 64 * 1024;
const failure = () => Error("target cannot resolve the Windows npm CLI from the selected npm command");
const interrupted = () => Error("push validation interrupted");
const get = (env, key) => Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];
async function regular(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !(await stat(file)).isFile()) throw failure();
  return realpath(file);
}

export async function resolveWindowsNpm({ cwd, env, signal, launch }) {
  if (signal?.aborted) throw interrupted();
  let owned;
  let retained = false;
  let forced;
  let timeout;
  let monitor;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const command = get(env, "COMSPEC") ?? (get(env, "SYSTEMROOT")
      ? path.win32.join(get(env, "SYSTEMROOT"), "System32", "cmd.exe") : undefined);
    const cmd = await regular(command);
    if (controller.signal.aborted) throw interrupted();
    owned = await mkdtemp(path.join(tmpdir(), "acc-push-npm-"));
    await chmod(owned, 0o700);
    const output = path.join(owned, "executor.jsonl");
    await writeFile(output, "", { flag: "wx", mode: 0o600 });
    const discoveryEnv = { ...env };
    for (const key of Object.keys(discoveryEnv)) if (/^(NODE_OPTIONS|ACC_PUSH_NPM_PROBE)$/i.test(key)) delete discoveryEnv[key];
    discoveryEnv.NODE_OPTIONS = [get(env, "NODE_OPTIONS"),
      `--import="${new URL('./push-npm-probe.mjs', import.meta.url).href}"`].filter(Boolean).join(" ");
    discoveryEnv.ACC_PUSH_NPM_PROBE = output;
    let bytes = 0;
    const stop = reason => { forced ??= reason; controller.abort(); };
    const check = () => {
      try { if (bytes + statSync(output).size > limit) stop("npm discovery output limit exceeded"); }
      catch { stop("npm discovery result unavailable"); }
    };
    timeout = setTimeout(() => stop("npm discovery timed out"), 10000);
    monitor = setInterval(check, 25);
    await launch(cmd, ["/d", "/v:off", "/s", "/c", query], {
      cwd, env: discoveryEnv, signal: controller.signal, quiet: true,
      onOutput: chunk => { bytes += chunk.length; check(); },
    });
    clearTimeout(timeout); clearInterval(monitor);
    check();
    if (controller.signal.aborted) throw interrupted();
    const handle = await open(output, "r");
    let contents;
    try {
      if (!(await handle.stat()).isFile()) throw failure();
      const buffer = Buffer.alloc(limit + 1);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      if (bytes + result.bytesRead > limit) throw failure();
      contents = buffer.subarray(0, result.bytesRead).toString("utf8");
    } finally { await handle.close(); }
    const records = contents.trim().split("\n");
    if (records.length !== 1) throw failure();
    const descriptor = JSON.parse(records[0]);
    if (descriptor?.schema !== 1 || Object.keys(descriptor).sort().join(",") !== "cli,node,schema") throw failure();
    const file = await regular(descriptor.node);
    const cli = await regular(descriptor.cli);
    if (file !== descriptor.node || cli !== descriptor.cli) throw failure();
    if (controller.signal.aborted) throw interrupted();
    return { file, prefixArgs: [cli] };
  } catch (error) {
    retained = Boolean(forced || signal?.aborted || error.code === "PUSH_TERMINATION_UNCONFIRMED");
    if (forced) throw Object.assign(terminationFailure(), { message: `target ${forced}; owned discovery resources retained for recovery` });
    if (error.code === "PUSH_TERMINATION_UNCONFIRMED") throw error;
    if (signal?.aborted) throw interrupted();
    throw failure();
  } finally {
    clearTimeout(timeout); clearInterval(monitor);
    signal?.removeEventListener("abort", abort);
    // A visible tree kill cannot establish ownership of historical descendants.
    if (owned && !retained && !signal?.aborted) await rm(owned, { recursive: true, force: true });
  }
}
