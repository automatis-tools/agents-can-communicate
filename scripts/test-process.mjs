import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { nodeTestArguments, testFileTimeout } from "./test-runner-plan.mjs";

// The outer process owns the pipes and process group. Exiting just a test
// worker cannot close stdout/stderr inherited by its surviving descendants.
export async function runTestBatch(files, { cwd, env, report, output = process.stdout,
  errorOutput = process.stderr }) {
  const selected = new Set(await Promise.all(files.map(file => realpath(path.resolve(cwd, file)))));
  const timeoutMs = testFileTimeout(env);
  const child = spawn(process.execPath, nodeTestArguments(files, { timings: report }), {
    cwd, env, detached: process.platform !== "win32", stdio: ["inherit", "pipe", "pipe", "ipc"],
  });
  return new Promise(resolve => {
    let settled = false;
    let expiring = false;
    let closeTimer;
    let timeoutRecord;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(closeTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.connected) child.disconnect();
      resolve({ code: expiring ? 1 : code, timeoutRecord });
    };
    const terminate = async () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        await new Promise(done => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"],
          { timeout: 2000 }, () => { child.kill("SIGKILL"); done(); }));
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
    };
    child.stdout.on("data", chunk => output.write(chunk));
    child.stderr.on("data", chunk => errorOutput.write(chunk));
    child.on("message", async message => {
      if (settled || expiring || message?.type !== "acc-test-file-deadline"
        || !selected.has(message.file) || message.timeoutMs !== timeoutMs) return;
      expiring = true;
      timeoutRecord = { file: message.file, durationMs: timeoutMs, success: false };
      errorOutput.write(`test file ${message.file} exceeded ${timeoutMs} ms; terminating test process tree\n`);
      await terminate();
      finish(1);
    });
    child.once("error", error => { errorOutput.write(`${error.message}\n`); finish(1); });
    child.once("close", code => finish(code ?? 1));
    // This also bounds an unexpected pipe holder started in a CLI preload,
    // outside a test file. Normal exit still waits for all output to drain.
    child.once("exit", () => {
      if (settled) return;
      closeTimer = setTimeout(async () => {
        expiring = true;
        errorOutput.write("test runner exited but its inherited output pipes stayed open\n");
        await terminate();
        finish(1);
      }, 5000);
    });
  });
}
