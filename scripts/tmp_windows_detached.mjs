// Measurement only (throwaway branch): does a detached, hidden worker outlive
// the process that started it, on Windows? The parent exits at once; the worker
// writes a marker three seconds later.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "acc-detached-"));
for (const [label, options] of [
  ["detached + windowsHide + stdio ignore", "{ detached: true, windowsHide: true, stdio: 'ignore' }"],
  ["detached only", "{ detached: true, stdio: 'ignore' }"],
  ["not detached", "{ windowsHide: true, stdio: 'ignore' }"],
]) {
  const marker = path.join(root, `${label.replace(/\W+/g, "-")}.txt`);
  const worker = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok'), 3000)`;
  const parent = `const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], ${options});
child.unref(); process.exit(0);`;
  const started = performance.now();
  execFileSync(process.execPath, ["-e", parent]);
  const parentMs = Math.round(performance.now() - started);
  await new Promise(resolve => setTimeout(resolve, 6000));
  console.log(`${label}: parent returned in ${parentMs} ms, worker survived: ${existsSync(marker)}`);
}
