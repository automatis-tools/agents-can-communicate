import { spawn } from "node:child_process";
import path from "node:path";

const LIMIT = 64 * 1024;

function stopTree(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  if (process.platform !== "win32") {
    // detached creates a new group for this command, never for the host client.
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
    return;
  }
  // Keep the shell alive until taskkill discovers its descendants. Killing the
  // shell first loses that relationship; an exited PID must never be reused.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return new Promise(resolve => {
    // Both processes must survive the indicator's outer deadline: libuv kills
    // non-detached Windows children when their spawning Node process exits.
    const killer = spawn(path.win32.join(root, "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"], { detached: true, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { killer.kill(); resolve(); }, 1000);
    const done = () => { clearTimeout(timer); resolve(); };
    killer.once("error", done);
    killer.once("exit", done);
    killer.unref();
  });
}

// The original command receives the original stdin. Cancellation belongs to
// the indicator request; its timeout must not leave another polling process.
export async function previousOutput(previous, payload, timeout, signal) {
  if (signal?.aborted || previous?.enabled === false
      || ["builtin", "disabled", "off", "none", "hidden"].includes(previous?.type)
      || typeof previous?.command !== "string" || !previous.command) return "";
  return new Promise(resolve => {
    let child, timer, settled = false, text = "";
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      // Continue draining stdout until Windows has stopped the tree. Closing
      // it first can make the shell exit before taskkill inspects its children.
      let cleanup;
      try { cleanup = stopTree(child); } catch { /* Cleanup must fail open. */ }
      Promise.resolve(cleanup).catch(() => {}).finally(() => {
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.unref();
        resolve(text.slice(0, LIMIT).trimEnd());
      });
    };
    try {
      child = spawn(previous.command, { shell: true, detached: true,
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      child.stdout.on("data", chunk => {
        if (settled) return;
        text += chunk;
        if (Buffer.byteLength(text) > LIMIT) finish();
      });
      child.stdin.on("error", () => {});
      child.once("error", finish);
      child.once("close", finish);
      signal?.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, timeout);
      child.stdin.end(payload);
      if (signal?.aborted) finish();
    } catch { finish(); }
  });
}
