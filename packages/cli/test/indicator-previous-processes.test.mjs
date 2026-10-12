import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { previousOutput } from "../src/indicator-previous-command.mjs";

function within(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

async function processFixture(t, { flood = false, partial = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-footer-tree-"));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\acc-footer-${randomUUID()}` : path.join(root, "child.sock");
  const server = net.createServer();
  const sockets = new Set();
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const closed = new Promise(resolve => server.on("connection", socket => {
    sockets.add(socket);
    socket.once("data", connected);
    socket.once("close", () => { sockets.delete(socket); resolve(); });
    socket.on("error", () => {});
  }));
  t.after(async () => {
    // An unfixed orphan exits through its own test-only IPC channel. No PID guessing.
    for (const socket of sockets) socket.end();
    if (sockets.size) await within(closed, 3000, "fixture child did not exit").catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  const child = path.join(root, "child.mjs"), parent = path.join(root, "parent.mjs");
  await writeFile(child, `import net from 'node:net';
    const connection=net.connect(${JSON.stringify(address)},()=>{connection.write('ready');process.stdout.write('ready');});
    connection.on('end',()=>process.exit(0));connection.on('error',()=>process.exit(0));`);
  await writeFile(parent, `import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,[${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>process.stdout.write(${JSON.stringify(flood ? 'x'.repeat(128*1024) : partial ? 'partial footer\n' : '')}));`);
  return { root, command: `"${process.execPath}" "${parent}"`, ready, closed };
}

test("the public indicator deadline stops a previous footer's descendant", async t => {
  const f = await processFixture(t);
  const marker = path.join(f.root, "marker.json");
  await writeFile(marker, JSON.stringify({ previous: { command: f.command } }));
  const child = spawn(process.execPath, [path.resolve("bin/acc-indicator.mjs"), "--adapter", "antigravity",
    "--previous", marker], { env: { ...process.env, ACC_DATA_HOME: f.root }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.resume();
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  child.stdin.end(JSON.stringify({ conversation_id: "unregistered" }));
  await within(f.ready, 4000, "the previous footer must start its child before this test can check cleanup");
  assert.equal(await within(exited, 4000, "indicator deadline did not return"), 0);
  await within(f.closed, 1500, "the timed-out footer left its descendant running");
  assert.match(output, /ACC/);
});


test("cancelling the indicator request stops the previous footer's descendant", async t => {
  const f = await processFixture(t);
  const controller = new AbortController();
  const pending = previousOutput({ command: f.command }, "{}", 10_000, controller.signal);
  await within(f.ready, 4000, "footer child did not start");
  controller.abort();
  await within(pending, 2000, "cancelled footer did not settle");
  await within(f.closed, 1500, "cancelled footer left its descendant running");
});

test("excessive previous-footer output stops its whole process tree", async t => {
  const f = await processFixture(t, { flood: true });
  const pending = previousOutput({ command: f.command }, "{}", 10_000);
  await within(f.ready, 4000, "footer child did not start");
  const output = await within(pending, 2000, "output limit did not stop the footer");
  assert.equal(output.length, 64 * 1024);
  await within(f.closed, 1500, "flooding footer left its descendant running");
});

test("the outer indicator deadline cancels a footer that starts late", async t => {
  const f = await processFixture(t, { partial: true });
  const marker = path.join(f.root, "marker.json");
  await writeFile(marker, JSON.stringify({ previous: { command: f.command } }));
  const driver = path.join(f.root, "indicator.mjs");
  // Advance the reader's clock after its modules load. A parent-side sleep can
  // expire during a slow import and accidentally exercise the footer's timer.
  // The adapter loads inside the reader, before it arms its deadline, so it is
  // loaded here first and the reader is given a turn to arm it.
  await writeFile(driver, `import {mock} from 'node:test';
    import {PassThrough} from 'node:stream';
    import {runIndicator} from ${JSON.stringify(pathToFileURL(path.resolve("packages/cli/src/indicator-command.mjs")).href)};
    import {loadAdapter} from ${JSON.stringify(pathToFileURL(path.resolve("packages/cli/src/adapter-catalog.mjs")).href)};
    await loadAdapter('antigravity');
    mock.timers.enable({apis:['setTimeout']});
    const stdin=new PassThrough();
    const pending=runIndicator({argv:process.argv.slice(2),stdin});
    await new Promise(resolve=>setImmediate(resolve));
    mock.timers.tick(1000);
    stdin.end('{"conversation_id":"unregistered"}');
    process.once('message',()=>mock.timers.tick(500));
    await pending;`);
  const child = spawn(process.execPath, [driver, "--adapter", "antigravity",
    "--previous", marker], { env: { ...process.env, ACC_DATA_HOME: f.root }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.resume();
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await within(f.ready, 4000, "the footer must start before the outer deadline");
  child.send("deadline");
  assert.equal(await within(exited, 4000, "outer indicator deadline did not return"), 0);
  await within(f.closed, 1500, "outer deadline left a previous footer's child running");
  assert.match(output, /ACC/);
  assert.doesNotMatch(output, /partial footer/, "must exercise the outer deadline, not the footer's own timeout");
  assert.equal(output.trim().split("\n").length, 1, "cancellation must not emit a second diagnostic");
});
