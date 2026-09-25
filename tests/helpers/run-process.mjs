import { spawn } from "node:child_process";

// Run a Node script with arguments and collect what it printed; stdout is
// parsed as JSON when it is JSON. The child is killed after the timeout.
export function runProcess(args, { timeoutMs = 4_000, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(stdout); } catch { /* not JSON: caller inspects stdout */ }
      resolve({ code, stdout, stderr, result });
    });
  });
}
