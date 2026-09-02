import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT } from "@agents-can-communicate/protocol";

import { storePaths } from "../src/index.mjs";
import { withWriterMutex } from "../src/writer-mutex.mjs";

const WORKER_FLAG = "--writer-reclaim-worker";
const DEAD_PID = 2_147_483_647;
const CONTENDERS = 8;
const workerMode = process.argv.includes(WORKER_FLAG);
const delay = duration => new Promise(resolve => { setTimeout(resolve, duration); });
const sleeper = new Int32Array(new SharedArrayBuffer(4));

if (workerMode) await runWorker();
else test("concurrent stale-lock reclaimers never overlap writer operations", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-reclaim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  await mkdir(paths.locks, { recursive: true });
  await mkdir(paths.tmp, { recursive: true });
  const critical = path.join(root, "critical");
  await mkdir(critical);

  let observedMax = 0;
  for (let round = 0; round < 4; round += 1) {
    const directory = path.join(paths.locks, "writer.lock");
    await mkdir(directory);
    await writeFile(path.join(directory, "owner.json"), JSON.stringify({
      pid: DEAD_PID,
      token: `dead-owner-${round}`,
      acquiredAt: new Date().toISOString(),
    }));
    await mkdir(path.join(root, `barrier-${round}`));

    observedMax = Math.max(observedMax, await contend(root, round, t));
  }

  assert.equal(observedMax, 1,
    `stale-lock reclaimers overlapped ${observedMax} writer operations`);
});

async function contend(root, round, t) {
  let maximum = 0;
  const workers = Array.from({ length: CONTENDERS }, () => fork(fileURLToPath(import.meta.url),
    [WORKER_FLAG], {
      env: { ...process.env, ACC_RECLAIM_ROOT: root, ACC_RECLAIM_ROUND: String(round) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }));
  t.after(() => workers.forEach(worker => { if (!worker.killed) worker.kill(); }));

  const ready = workers.map(worker => new Promise((resolve, reject) => {
    worker.on("message", message => {
      if (message?.type === "ready") resolve();
      if (message?.type === "count") maximum = Math.max(maximum, message.value);
    });
    worker.once("error", reject);
  }));
  const exited = workers.map(worker => new Promise((resolve, reject) => {
    let stderr = "";
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", chunk => { stderr += chunk; });
    worker.once("exit", code => code === 0 ? resolve() : reject(
      new Error(`reclaim worker exited ${code}: ${stderr}`)));
  }));
  await Promise.all(ready);
  workers.forEach(worker => worker.send({ type: "start" }));
  await Promise.all(exited);
  return maximum;
}

async function runWorker() {
  const root = process.env.ACC_RECLAIM_ROOT;
  const paths = storePaths(root);
  const critical = path.join(root, "critical");
  const barrier = path.join(root, `barrier-${process.env.ACC_RECLAIM_ROUND}`);
  let joinedBarrier = false;
  process.send?.({ type: "ready" });
  await new Promise(resolve => process.once("message", resolve));

  for (let retry = 0; retry < 20; retry += 1) {
    try {
      await withWriterMutex(paths, {
        root,
        clock: { now: () => new Date().toISOString() },
        pidIsAlive: pid => {
          if (pid !== DEAD_PID) return true;
          if (!joinedBarrier) {
            joinedBarrier = true;
            writeFileSync(path.join(barrier, String(process.pid)), "ready\n");
            while (readdirSync(barrier).length < CONTENDERS) {
              Atomics.wait(sleeper, 0, 0, 5);
            }
          }
          return false;
        },
        attempts: 10_000,
        waitMs: 1,
        acquireTimeoutMs: 8_000,
      }, async () => {
        const marker = path.join(critical, String(process.pid));
        await writeFile(marker, "inside\n");
        await delay(20);
        process.send?.({ type: "count", value: (await readdir(critical)).length });
        await delay(40);
        await rm(marker);
      });
      return;
    } catch (error) {
      if (error.code !== EXIT.CONFLICT || retry === 19) throw error;
      await delay(2);
    }
  }
}
