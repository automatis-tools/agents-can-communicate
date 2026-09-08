import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMachine } from "./codex-local-daemon-machine.mjs";
import { queueState, receipt, sendMessage, waitMarker, withPeer }
  from "./codex-local-daemon-actions.mjs";
import { binding, exists, idle, settled } from "./codex-local-daemon-product-state.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";

export async function productSenderHome(h) {
  await idle(h);
  const s = scenario(h, "P15");
  const other = await createMachine({ tarball: h.tarball, codex: h.codex, phase: "transport",
    output: path.join(h.output, "sender-daemon") });
  try {
    const loaded = () => withPeer(other, peer => peer.request("thread/loaded/list", {}));
    s.equal((await loaded()).data, []);
    const marker = path.join(h.B, "receiver-socket.txt");
    const sent = await sendMessage(h, { id: "different_sender_home", marker,
      env: { ...h.accEnv, CODEX_HOME: other.codexHome } });
    s.equal(sent.delivery[0].outcome, "offered");
    await waitMarker(h, "receiver-b1", marker, h.B); await settled(h, sent.message);
    s.equal((await loaded()).data, [], "sender daemon remains untouched");
    const current = await binding(h);
    const { readNativeEndpoint } = await h.module("adapter-codex/src/native-endpoint.mjs");
    const endpoint = await readNativeEndpoint({ runtimeDir: h.roles["receiver-b1"].runtimeDir,
      endpointId: current.opaqueEndpointRef });
    s.equal(endpoint.socketPath, path.join(h.codexHome, "app-server-control/app-server-control.sock"));
    s.fact("binding", "matched", "sender", "receiver-b1");
  } finally {
    const cleanup = await other.cleanup();
    s.equal(cleanup.outcome, "passed", "secondary owned daemon and home cleaned");
  }
  s.finish();
}

export async function productFaults(h) {
  await idle(h);
  const s = scenario(h, "P16");
  const b = h.roles["receiver-b1"];
  const registered = await binding(h);
  const file = path.join(b.runtimeDir, "codex-native-endpoints", `${registered.opaqueEndpointRef}.json`);
  const bytes = await readFile(file, "utf8");
  const original = JSON.parse(bytes);
  const mutations = [
    ["server-version", { ...original, clientVersion: "0.999.0" }],
    ["unloaded-id", { ...original, threadId: "unloaded-diagnostic-thread" }],
    ["missing-socket", { ...original, socketPath: path.join(h.root, "absent.sock") }],
    ["malformed", { ...original, unexpected: true }],
  ];
  for (const [name, mutated] of mutations) {
    const marker = path.join(h.B, `fault-${name}.txt`);
    try {
      await writeFile(file, JSON.stringify(mutated));
      const sent = await sendMessage(h, { id: `fault_${name.replaceAll("-", "_")}`, marker });
      s.equal(sent.delivery[0].outcome, "queued", `controlled ${name} injection must refuse native success`);
      s.equal((await receipt(h, sent.message)).state, "queued");
      s.equal((await queueState(h, b.threadId)).some(item => item.clientMessageId === sent.message.messageId), false);
      s.equal(await exists(marker), false);
      const serialized = JSON.stringify(sent.delivery);
      for (const secret of [original.endpointId, original.socketPath, file]) {
        s.check(!serialized.includes(secret), "public delivery result omits private endpoint data");
      }
    } finally { await writeFile(file, bytes); }
  }
  s.fact("diagnostic", "sanitized"); s.fact("submission", "rejected"); s.fact("receipt", "queued"); s.finish();
}
