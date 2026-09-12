import assert from "node:assert/strict";
import { createCodexServiceSetup } from "../src/service-setup.mjs";
import { probeNativeDelivery } from "../src/native-delivery.mjs";
import { maintenanceFixture } from "./maintenance-fixture.mjs";

export async function serviceFixture(t, { missing = true, ...options } = {}) {
  const f = await maintenanceFixture(t, options);
  f.state.serverVersion = "0.154.0";
  f.state.threads = [];
  if (missing) await f.stop();
  const starts = [], requests = [];
  const run = async (command, args, config) => {
    if (args.join(" ") === "app-server daemon start") {
      starts.push({ command, args, config });
      assert.equal(config.env.HOME, f.context.home);
      assert.equal(config.env.CODEX_HOME, f.codexHome);
      assert.equal(config.cwd, f.codexHome);
      assert.equal(config.timeout, 15_000);
      if (f.state.startThrows) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      if (f.state.startFails) return { status: 1, stdout: "", stderr: "private failure" };
    }
    return f.run(command, args, config);
  };
  const open = () => ({ notify() {}, close: async () => {}, request: async method => {
    requests.push(method);
    if (method === "initialize") return { userAgent: `codex/${f.state.serverVersion} (Mac OS)` };
    if (method === "thread/loaded/list") {
      if (f.state.protocolFails) throw new Error("protocol mismatch");
      return { data: f.state.threads.map(thread => thread.id), nextCursor: null };
    }
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    throw new Error(`Unexpected metadata RPC: ${method}`);
  } });
  const probe = args => probeNativeDelivery({ ...args, open });
  return { ...f, ...createCodexServiceSetup({ run, probe }), run, probe, starts, requests };
}
