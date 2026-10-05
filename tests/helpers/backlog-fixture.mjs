import assert from "node:assert/strict";

const orderedSnapshot = snapshot => Object.fromEntries(Object.entries(snapshot)
  .map(([kind, records]) => [kind, Array.isArray(records)
    ? [...records].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : records]));

// Historical setup uses the contract reference store to avoid rereading the
// entire backlog after every API call. Publication still uses the installed
// filesystem store's validation, journal, writer mutex, and durable flushes.
// Live hook, CLI, and MCP assertions begin only after both stores agree.
export async function publishBacklogFixture({ memory, store, workspaceId }) {
  // Detach expectations before publishing: the stores can share input records.
  const snapshot = structuredClone(await memory.snapshot(workspaceId));
  assert.equal(snapshot.workspace?.workspaceId, workspaceId,
    "a backlog fixture must already be materialised");
  const records = await memory.stateEnvelopes(workspaceId);
  const history = await memory.eventsSince(workspaceId, null, Number.MAX_SAFE_INTEGER);
  const expectedHistory = structuredClone(history);
  assert.equal(history.trimmedThrough, null, "a backlog fixture must retain its full event history");

  await store.transaction(tx => {
    for (const { kind, id, record } of records) tx.put(kind, id, record);
    for (const event of history.events) tx.append(event);
  }, { kinds: [...new Set(records.map(record => record.kind))] });

  // Only envelope generations change during publication. Public session
  // generations, message ids, receipt facts, and event sequences stay intact.
  assert.deepEqual(orderedSnapshot(await store.snapshot(workspaceId)), orderedSnapshot(snapshot),
    "durable backlog records must match the API-generated fixture");
  assert.deepEqual(await store.eventsSince(workspaceId, null, expectedHistory.events.length + 1), expectedHistory,
    "durable backlog history must match the API-generated fixture");
}
