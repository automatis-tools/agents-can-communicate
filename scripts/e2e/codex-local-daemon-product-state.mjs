import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { until } from "./codex-local-daemon-machine.mjs";
import { receipt, threadState, trust } from "./codex-local-daemon-actions.mjs";

export const exists = file => readFile(file).then(() => true, () => false);
export const binding = h => h.service.store.ephemeral.get("deliveryBinding", h.roles["receiver-b1"].sessionId);
export const snapshot = h => h.service.store.snapshot(h.roles["receiver-b1"].workspaceId,
  { kinds: ["message", "receipt", "session"] });
export async function events(h) {
  let cursor = null;
  const result = [];
  for (;;) {
    const page = await h.service.store.eventsSince(h.roles["receiver-b1"].workspaceId, cursor, 100);
    result.push(...page.events);
    if (page.events.length < 100) return result;
    assert.notEqual(page.cursor, cursor);
    cursor = page.cursor;
  }
}
export async function idle(h, role = "receiver-b1") {
  await until(`idle ${role}`, async () => {
    await trust(h, role);
    return (await threadState(h, h.roles[role].threadId)).status === "idle";
  }, { timeoutMs: 180_000 });
}
export async function settled(h, message) {
  await until("model read and reply", async () => {
    await trust(h, "receiver-b1");
    return (await receipt(h, message)).state === "acknowledged";
  }, { timeoutMs: 180_000 });
  await idle(h);
}
