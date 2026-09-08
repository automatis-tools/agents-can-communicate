import path from "node:path";
import { stat } from "node:fs/promises";
import { createMachine, observeHooks, run, until } from "./codex-local-daemon-machine.mjs";
import { attachSender, identify, launch, receipt, sendMessage, threadState }
  from "./codex-local-daemon-actions.mjs";
import { binding, exists, idle } from "./codex-local-daemon-product-state.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";
import { changePolicy } from "./codex-local-daemon-product-policy.mjs";

async function own(h, name, callback) {
  const child = await createMachine({ tarball: h.tarball, codex: h.codex, phase: "product",
    output: path.join(h.output, name) });
  child.scenarios = [];
  let s;
  try {
    await observeHooks(child);
    s = await callback(child);
  } finally {
    const cleanup = await child.cleanup();
    if (cleanup.outcome !== "passed") throw new Error(`secondary ${name} cleanup failed`);
  }
  h.scenarios.push(s.finish());
}

async function rememberDaemon(h) {
  const socket = path.join(h.codexHome, "app-server-control/app-server-control.sock");
  await until("restored daemon socket", () => stat(socket).then(info => info.isSocket(), () => false));
  const pids = (await run("/usr/sbin/lsof", ["-t", socket])).trim().split(/\s+/).map(Number);
  h.daemonPids.push(...pids.filter(pid => !h.daemonPids.includes(pid)));
}

export async function productEmbedded(h) {
  await own(h, "embedded", async child => {
    await run(child.codex, ["app-server", "daemon", "restart"], { cwd: child.A, env: child.env });
    await rememberDaemon(child);
    await launch(child, "receiver-b1", { args: ["-c", 'model_reasoning_effort="low"'] });
    const b = await identify(child, "receiver-b1"); await attachSender(child);
    const s = scenario(child, "P10");
    const state = await threadState(child, b.threadId);
    s.equal([b.hookCwd, b.actualCwd, state.cwd], [child.B, child.B, child.B]);
    s.equal(state.loaded, false, "config override selects an unreachable embedded thread");
    s.equal(await binding(child), null);
    const sent = await sendMessage(child, { id: "embedded_durable", marker: path.join(child.B, "embedded-offer.txt") });
    s.equal(sent.delivery[0].outcome, "queued");
    s.equal((await receipt(child, sent.message)).state, "queued");
    s.equal(await exists(path.join(child.B, "embedded-offer.txt")), false);
    const inbox = (await child.acc(["inbox", "--message", sent.message.messageId,
      "--session", b.sessionId, "--generation", b.generation])).data;
    s.check(JSON.stringify(inbox).includes(sent.message.messageId));
    s.equal((await receipt(child, sent.message)).state, "retrieved");
    s.fact("binding", "absent"); s.fact("receipt", "queued"); s.fact("receipt", "retrieved");
    return s;
  });
}

export async function productDaemonRecovery(h) {
  await own(h, "daemon-recovery", async child => {
    await launch(child, "receiver-b1"); const b = await identify(child, "receiver-b1");
    await attachSender(child); await idle(child);
    const s = scenario(child, "P11");
    s.check(await binding(child));
    await run(child.codex, ["app-server", "daemon", "stop"], { cwd: child.A, env: child.env })
      .catch(() => null);
    const stopped = () => child.daemonPids.every(pid => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    await until("owned daemon stopped", stopped, { timeoutMs: 20_000 });
    const sent = await sendMessage(child, { id: "daemon_absent", marker: path.join(child.B, "absent-offer.txt") });
    s.equal(sent.delivery[0].outcome, "queued");
    s.equal((await receipt(child, sent.message)).state, "queued");
    s.equal(await exists(path.join(child.B, "absent-offer.txt")), false);
    await changePolicy(child, "actionable");
    s.equal(stopped(), true, "reinstall never starts the daemon");
    const { readInstalledLivePolicy } = await child.module("installer/src/live-policy.mjs");
    s.equal(await readInstalledLivePolicy({ dataHome: child.dataHome, adapterId: "codex" }), "actionable");
    const doctor = (await child.acc(["doctor"])).data;
    s.check(JSON.stringify(doctor).includes("degraded") || JSON.stringify(doctor).includes("feature_probe_failed"),
      "daemon absence produces a truthful degraded diagnostic");
    await child.pty.request({ action: "close", role: "receiver-b1" });
    await run(child.codex, ["app-server", "daemon", "start"], { cwd: child.A, env: child.env });
    await rememberDaemon(child);
    await launch(child, "receiver-b1"); await identify(child, "receiver-b1");
    s.check(await binding(child), "a later ordinary session binds after explicit daemon restoration");
    s.check(b.threadId !== child.roles["receiver-b1"].threadId);
    s.fact("daemon", "stopped", "daemon-a"); s.fact("consent", "preserved");
    s.fact("receipt", "queued"); s.fact("binding", "fresh");
    return s;
  });
}
