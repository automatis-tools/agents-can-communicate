import { initializeCodex } from "./app-server-client.mjs";
import { failMaintenance } from "./maintenance-host.mjs";

async function loadedThreads(peer) {
  const ids = [], cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const response = await peer.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response?.data) || response.data.some(id => typeof id !== "string" || !id)) {
      failMaintenance("maintenance_protocol_unavailable");
    }
    ids.push(...response.data);
    cursor = response.nextCursor ?? null;
    if (cursor === null) {
      if (new Set(ids).size !== ids.length) failMaintenance("maintenance_protocol_unavailable");
      return ids.sort();
    }
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) failMaintenance("maintenance_protocol_unavailable");
    cursors.add(cursor);
  }
  failMaintenance("maintenance_protocol_unavailable");
}

// The caller receives counts only. No thread/list previews, turns, queue bodies,
// notification history, or vendor errors are retained in maintenance snapshots.
export async function maintenanceWorkload(snapshot, open) {
  let peer;
  try {
    peer = await open({ socketPath: snapshot.socketPath });
    if (await initializeCodex(peer) !== snapshot.serverVersion) failMaintenance("daemon_version_changed");
    const ids = await loadedThreads(peer);
    let busyThreads = 0, queuedRequests = 0;
    for (const threadId of ids) {
      const response = await peer.request("thread/read", { threadId, includeTurns: false });
      const thread = response?.thread;
      if (thread?.id !== threadId || !Array.isArray(thread.turns) || thread.turns.length !== 0
        || !["idle", "active"].includes(thread.status?.type)) failMaintenance("maintenance_protocol_unavailable");
      if (thread.status.type === "active") busyThreads += 1;
      const queue = await peer.request("thread/queue/list", { threadId });
      if (!Array.isArray(queue?.data) || queue.nextCursor != null
        || queue.data.some(entry => typeof entry?.id !== "string" || !entry.id)) {
        failMaintenance("maintenance_protocol_unavailable");
      }
      queuedRequests += queue.data.length;
    }
    if (JSON.stringify(await loadedThreads(peer)) !== JSON.stringify(ids)) failMaintenance("loaded_threads_changed");
    return { busyThreads, queuedRequests };
  } finally { await peer?.close(); }
}
