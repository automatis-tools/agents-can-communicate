import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PROTOCOL_CONTRACT, RELAY_MODES, listRegistrations, newRelayId, readRegistration,
  relayDir, removeRegistration, writeRegistration } from "../src/relay-endpoint.mjs";

async function runtime(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-relay-reg-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const record = (overrides = {}) => ({ schemaVersion: 1, endpointId: newRelayId(),
  conversationId: "3ed65ea5-31f2-4ddf-b6c7-e3c85a9a3c29", agyPid: 4242, relayPid: 4343,
  socketPath: "/tmp/acc-ch-501/rabcdef123456.sock", nonce: "a".repeat(64),
  clientVersion: "1.2.7", protocolContract: PROTOCOL_CONTRACT, modes: [...RELAY_MODES],
  leaseUntil: "2026-09-21T18:00:00.000Z", ...overrides });

test("a registration is written private and read back exactly", async t => {
  const runtimeDir = await runtime(t);
  const written = record();

  const file = await writeRegistration({ runtimeDir, record: written });

  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(relayDir(runtimeDir))).mode & 0o777, 0o700);
  assert.deepEqual(await readRegistration({ runtimeDir, endpointId: written.endpointId }), written);
});

test("the record never carries the session endpoint", async t => {
  const runtimeDir = await runtime(t);
  for (const secret of ["lsAddress", "csrfToken", "token", "address"]) {
    await assert.rejects(() => writeRegistration({ runtimeDir,
      record: { ...record(), [secret]: "x" } }), /invalid Antigravity relay registration/);
  }
});

test("a malformed, linked or oversized record reads as absent", async t => {
  const runtimeDir = await runtime(t);
  const good = record();
  await writeRegistration({ runtimeDir, record: good });
  const file = path.join(relayDir(runtimeDir), `${good.endpointId}.json`);

  await writeFile(file, "{not json", { mode: 0o600 });
  assert.equal(await readRegistration({ runtimeDir, endpointId: good.endpointId }), null);

  await rm(file);
  const elsewhere = path.join(runtimeDir, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify(good), { mode: 0o600 });
  await symlink(elsewhere, file);
  assert.equal(await readRegistration({ runtimeDir, endpointId: good.endpointId }), null);

  assert.equal(await readRegistration({ runtimeDir, endpointId: "../../etc/passwd" }), null);
});

test("listing skips neighbours it cannot read and removal is idempotent", async t => {
  const runtimeDir = await runtime(t);
  const one = record();
  await writeRegistration({ runtimeDir, record: one });
  await writeFile(path.join(relayDir(runtimeDir), "junk.json"), "[]", { mode: 0o600 });

  assert.deepEqual((await listRegistrations({ runtimeDir })).map(item => item.endpointId),
    [one.endpointId]);
  await removeRegistration({ runtimeDir, endpointId: one.endpointId });
  await removeRegistration({ runtimeDir, endpointId: one.endpointId });
  assert.deepEqual(await listRegistrations({ runtimeDir }), []);
});
