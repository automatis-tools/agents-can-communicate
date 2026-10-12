import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { waitForWorkers } from "./helpers/fixture-cleanup.mjs";

// Worker construction precedes process's asynchronous `worker` event. A
// cleanup called immediately after an optional writer starts must still wait.
test("worker cleanup drains a writer whose registration event is still queued", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-cleanup-worker-"));
  const file = path.join(root, "published");
  let cleanup;
  const listeners = process.listenerCount("worker");
  waitForWorkers({ after(fn) { cleanup = fn; } });
  const worker = new Worker(`
    const { writeFileSync } = require("node:fs");
    const { workerData } = require("node:worker_threads");
    setTimeout(() => writeFileSync(workerData, "writer finished"), 25);
  `, { eval: true, workerData: file });
  worker.unref();
  t.after(async () => { await worker.terminate(); await rm(root, { recursive: true, force: true }); });

  await cleanup();
  assert.equal(await readFile(file, "utf8").catch(() => null), "writer finished",
    "cleanup returned before the newly constructed worker finished writing");
  assert.equal(process.listenerCount("worker"), listeners);
});

// Draining a snapshot and removing the listener early misses another writer
// started while the first worker is finishing.
test("worker cleanup also drains a writer started during cleanup", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-cleanup-successor-"));
  const file = path.join(root, "published");
  let cleanup;
  waitForWorkers({ after(fn) { cleanup = fn; } });
  const workers = [];
  const first = new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.once("message", () => parentPort.postMessage("start successor"));
  `, { eval: true });
  workers.push(first);
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.terminate()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => first.once("online", resolve));
  first.once("message", () => {
    const successor = new Worker(`
      const { writeFileSync } = require("node:fs");
      const { workerData } = require("node:worker_threads");
      setTimeout(() => writeFileSync(workerData, "successor finished"), 25);
    `, { eval: true, workerData: file });
    successor.unref();
    workers.push(successor);
  });
  const draining = cleanup();
  first.postMessage("finish");
  await draining;
  assert.equal(await readFile(file, "utf8").catch(() => null), "successor finished",
    "cleanup returned while a successor writer was still running");
});
