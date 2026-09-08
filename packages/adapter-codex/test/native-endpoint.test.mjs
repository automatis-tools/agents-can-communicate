import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { bindNativeSession, retireNativeSession } from "../src/native-delivery.mjs";
import { readNativeEndpoint, writeNativeEndpoint } from "../src/native-endpoint.mjs";
import { nativeFixture } from "./native-fixture.mjs";

async function registered(t) {
  const h = await nativeFixture(t);
  const binding = await bindNativeSession(h);
  assert.equal(binding.supported, true);
  const endpointId = binding.opaqueEndpointRef;
  const dir = path.join(h.runtimeDir, "codex-native-endpoints");
  const file = path.join(dir, `${endpointId}.json`);
  return { ...h, binding, endpointId, dir, file, record: JSON.parse(await readFile(file, "utf8")) };
}

test("a registration cannot be read through a writable or linked directory", async t => {
  const h = await registered(t);
  await chmod(h.dir, 0o777);
  assert.equal(await readNativeEndpoint(h), null);
  await chmod(h.dir, 0o700);
  const moved = `${h.dir}-moved`;
  await rename(h.dir, moved);
  await symlink(moved, h.dir, "dir");
  assert.equal(await readNativeEndpoint(h), null);
});

test("registration files are private, closed, bounded and identified by the requested ID", async t => {
  const h = await registered(t);
  assert.equal((await stat(h.file)).mode & 0o777, 0o600);
  assert.equal((await readNativeEndpoint(h)).endpointId, h.endpointId);
  for (const altered of [{ ...h.record, extra: "private content" },
    { ...h.record, schemaVersion: 2 }, { ...h.record, endpointId: "codex_endpoint_" + "0".repeat(32) },
    { ...h.record, socketPath: "relative.sock" }, { ...h.record, leaseUntil: "invalid" }]) {
    await writeFile(h.file, JSON.stringify(altered));
    assert.equal(await readNativeEndpoint(h), null);
  }
  await writeFile(h.file, " ".repeat(9_000));
  assert.equal(await readNativeEndpoint(h), null);
  await writeFile(h.file, JSON.stringify(h.record));
  await chmod(h.file, 0o644);
  assert.equal(await readNativeEndpoint(h), null);
});

test("file links and traversal cannot select another receiver registration", async t => {
  const h = await registered(t);
  const moved = `${h.file}.real`;
  await rename(h.file, moved);
  await symlink(moved, h.file);
  assert.equal(await readNativeEndpoint(h), null);
  assert.equal(await readNativeEndpoint({ ...h, endpointId: `../${h.endpointId}` }), null);
});

test("retiring an old address leaves a later binding's registration available", async t => {
  const h = await registered(t);
  const newer = await bindNativeSession(h);
  assert.equal(newer.supported, true);
  assert.notEqual(newer.opaqueEndpointRef, h.endpointId);
  await retireNativeSession({ ...h, binding: h.binding });
  assert.equal(await readNativeEndpoint(h), null);
  assert.equal((await readNativeEndpoint({ ...h, endpointId: newer.opaqueEndpointRef })).threadId,
    h.record.threadId);
});


test("a nonregular FIFO registration is refused without waiting for a writer", {
  skip: process.platform === "win32" ? "Unix FIFO semantics" : false,
}, async t => {
  const h = await registered(t);
  await rename(h.file, `${h.file}.original`);
  execFileSync("mkfifo", ["-m", "600", h.file]);
  const script = `import { readNativeEndpoint } from ${JSON.stringify(new URL("../src/native-endpoint.mjs", import.meta.url).href)};
    const result = await readNativeEndpoint(JSON.parse(process.argv[1]));
    if (result !== null) process.exit(2);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script,
    JSON.stringify({ runtimeDir: h.runtimeDir, endpointId: h.endpointId })], { timeout: 1_000 });
  assert.equal(child.status, 0, "endpoint read must refuse FIFO within the subprocess deadline");
});

test("publication exposes complete records while concurrent readers inspect the address", async t => {
  const h = await registered(t);
  const results = [];
  let done = false;
  const publication = writeNativeEndpoint({ runtimeDir: h.runtimeDir, record: h.record })
    .finally(() => { done = true; });
  do { results.push(await readNativeEndpoint(h)); } while (!done);
  await publication;
  assert.ok(results.length > 0);
  assert.ok(results.every(record => record?.endpointId === h.endpointId),
    "atomic replacement must never expose missing or partially written JSON");
});
