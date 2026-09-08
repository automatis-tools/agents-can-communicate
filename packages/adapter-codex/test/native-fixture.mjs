import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const THREAD = "01a063ed-a384-7fe2-b443-7fedf1593f6b";

export async function nativeFixture(t) {
  const root = await realpath(await mkdtemp(path.join(
    process.platform === "win32" ? tmpdir() : "/tmp", "acc-cx-")));
  const cwd = path.join(root, "B receiver with spaces");
  const runtimeDir = path.join(root, "runtime");
  const home = path.join(root, "home");
  await mkdir(cwd);
  await mkdir(path.join(home, "app-server-control"), { recursive: true });
  const socketPath = path.join(home, "app-server-control", "app-server-control.sock");
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(socketPath, resolve); });
  t.after(async () => { await new Promise(resolve => socket.close(resolve));
    await rm(root, { recursive: true, force: true }); });
  const state = { version: "0.152.1", loaded: [THREAD],
    threads: [{ id: THREAD, cwd, status: { type: "idle" } }], queue: [], error: null };
  const calls = [];
  const peer = {
    notify() {}, async close() {},
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "initialize") return { userAgent: `codex/${state.version} (Mac OS)` };
      if (method === "thread/loaded/list") return { data: state.loaded, nextCursor: null };
      if (method === "thread/list") return { data: state.threads, nextCursor: null };
      if (state.error) throw state.error;
      if (!state.loaded.includes(params.threadId)) throw new Error("unknown thread");
      if (method === "thread/queue/list") return { data: state.queue.filter(
        item => item.threadId === params.threadId), nextCursor: null };
      if (method === "thread/queue/add") {
        const item = { id: `qs_${state.queue.length + 1}`, threadId: params.threadId,
          clientUserMessageId: params.clientUserMessageId, input: params.input };
        state.queue.push(item);
        return { queuedSubmission: item };
      }
      throw new Error("unexpected method");
    },
  };
  const opened = [];
  const open = options => { opened.push(options.socketPath); return peer; };
  return { root, cwd, runtimeDir, socketPath, state, calls, open, opened,
    env: { CODEX_HOME: home }, event: { sessionId: THREAD, cwd },
    clientPid: process.pid, clientVersion: "0.152.1" };
}
