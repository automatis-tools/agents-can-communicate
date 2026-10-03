// An interactive client in a terminal for an end-to-end test, through
// pty-driver.py: a ConPTY on Windows, a pseudo-terminal elsewhere.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { resolveExecutable } from "../../packages/adapter-sdk/src/executables.mjs";

const DRIVER = fileURLToPath(new URL("./pty-driver.py", import.meta.url));
const PYTHON = process.platform === "win32" ? "python" : "python3";

/** What a terminal shows, without its control sequences. */
export const plainScreen = text => text.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>()][0-9A-Za-z]?/g, "");

export async function startTerminal(argv, { cwd, env, log }) {
  await writeFile(log, "");
  // Python is found on this process's PATH: a client's environment may carry
  // only the client's own directories, and the driver hands it on unchanged.
  const python = await resolveExecutable(PYTHON);
  if (python === null) throw new Error(`${PYTHON} is not on PATH; the terminal driver needs it`);
  const driver = spawn(python, [DRIVER, JSON.stringify(argv), log, cwd], { env,
    stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const first = await new Promise((resolve, reject) => {
    createInterface({ input: driver.stdout }).once("line", resolve);
    driver.once("error", reject);
    driver.once("exit", code => reject(new Error(`terminal driver exited with ${code}`)));
  });
  const { pid } = JSON.parse(first);
  const command = value => driver.stdin.write(`${JSON.stringify(value)}\n`);
  return {
    pid,
    send: text => command({ op: "send", text }),
    screen: async (length = 2000) => plainScreen(await readFile(log, "utf8")).slice(-length),
    close: async () => {
      if (driver.exitCode !== null) return;
      const exited = new Promise(resolve => driver.once("exit", resolve));
      command({ op: "quit" });
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (driver.exitCode === null) driver.kill();
    },
  };
}
