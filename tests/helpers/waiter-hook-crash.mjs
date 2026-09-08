import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// These loader edits only pause installed executables and report store opens.
// Both hooks still execute real binding writes, locks and journal transactions.
const bootstrapSource = String.raw`
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const role = process.env.ACC_FIXTURE_HOOK_ROLE;
const waiting = new Map();
process.on("message", message => waiting.get(message.release)?.());
globalThis.accWaiterPause = stage => new Promise(resolve => {
  waiting.set(stage, resolve);
  process.send({ stage });
});
function replaceOnce(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw Error("waiter crash seam must match once: " + needle);
  return source.replace(needle, replacement);
}
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (typeof result.source !== "string" && !ArrayBuffer.isView(result.source)) return result;
  let source = Buffer.from(result.source).toString();
  if (role === "holder" && url.endsWith("/hook-runner/src/runner.mjs")) {
    const needle = "    const session = await context.service.openSession({";
    source = replaceOnce(source, needle,
      '    await globalThis.accWaiterPause("before-open");\n' + needle);
  }
  if (role === "waiter" && url.endsWith("/hook-runner/src/session-lifecycle.mjs")) {
    source = replaceOnce(source, "export function withSessionLifecycle(",
      "export async function withSessionLifecycle(");
    const needle = "  return withWriterMutex(";
    source = replaceOnce(source, needle,
      '  await globalThis.accWaiterPause("waiter-context-ready");\n' + needle);
  }
  if (role === "waiter" && url.endsWith("/storage-filesystem/src/writer-mutex.mjs")) {
    const needle = "        const current = await readOwner(directory, root, openFile);";
    source = replaceOnce(source, needle,
      '        if (directory.includes("lifecycle-locks")) process.send({ stage: "waiter-contended" });\n'
      + needle);
  }
  if (url.endsWith("/storage-filesystem/src/store.mjs")) {
    if (role === "holder") {
      const needle = '      await failAt?.("after-journal");';
      source = replaceOnce(source, needle,
        '      await globalThis.accWaiterPause("after-journal");\n' + needle);
    } else {
      const needle = "  await recoverOpenJournals();";
      source = replaceOnce(source, needle,
        '  process.send({ stage: "store-recovery" });\n' + needle);
    }
  }
  return { ...result, source };
} });
process.argv = [process.execPath, process.env.ACC_FIXTURE_HOOK_BIN, "claude_code"];
await import(pathToFileURL(process.argv[1]));
process.disconnect();
`;

function startFixture(bootstrap, packed, payload, participantId, role) {
  const child = fork(bootstrap, [], { cwd: packed.project,
    env: { ...packed.env, ACC_PARTICIPANT: participantId,
      ACC_FIXTURE_HOOK_ROLE: role, ACC_FIXTURE_HOOK_BIN: packed.hookBin },
    stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const messages = [], pending = [];
  let stdout = "", stderr = "", exit = null;
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const dispatch = () => {
    for (const item of [...pending]) {
      const found = messages.find(message => message.stage === item.stage);
      if (found === undefined && exit === null) continue;
      pending.splice(pending.indexOf(item), 1);
      clearTimeout(item.timer);
      if (found !== undefined) item.resolve(found);
      else item.reject(new Error(`${role} exited before ${item.stage}: ${JSON.stringify(exit)} ${stderr}`));
    }
  };
  child.on("message", message => { messages.push(message); dispatch(); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const finished = new Promise(resolve => child.on("exit", (code, signal) => {
    clearTimeout(deadline);
    exit = { code, signal };
    dispatch();
    resolve({ ...exit, stdout, stderr });
  }));
  child.stdin.end(JSON.stringify(payload));
  return { messages, finished,
    reached: stage => new Promise((resolve, reject) => {
      const item = { stage, resolve, reject, timer: setTimeout(() => {
        pending.splice(pending.indexOf(item), 1);
        reject(new Error(`${role} did not reach ${stage}: ${stderr}`));
      }, 10_000) };
      pending.push(item);
      dispatch();
    }),
    release: stage => child.send({ release: stage }),
    stop: async () => {
      if (exit === null) child.kill("SIGKILL");
      return finished;
    },
  };
}

export async function crashHolderWithWaitingHook(packed, { payload, participantId }) {
  const bootstrap = path.join(packed.root, "waiter-hook-crash.mjs");
  await writeFile(bootstrap, bootstrapSource);
  const holder = startFixture(bootstrap, packed, payload, participantId, "holder");
  let waiter;
  try {
    await holder.reached("before-open");
    const original = await packed.findBinding(payload.session_id);
    assert.ok(original?.generation, "the holder must reserve its owner pair before opening");
    waiter = startFixture(bootstrap, packed, payload, participantId, "waiter");
    await waiter.reached("waiter-context-ready");
    assert.equal(waiter.messages.filter(message => message.stage === "store-recovery").length, 1,
      "the waiter must open its first store before the holder publishes its journal");
    waiter.release("waiter-context-ready");
    await waiter.reached("waiter-contended");
    holder.release("before-open");
    await holder.reached("after-journal");
    assert.equal((await holder.stop()).signal, "SIGKILL");
    const waiterExit = await waiter.finished;
    assert.equal(waiterExit.code, 0, waiterExit.stderr);
    return { original, waiterExit, afterWaiter: await packed.findBinding(payload.session_id) };
  } finally {
    await Promise.all([holder.stop(), waiter?.stop()]);
  }
}
