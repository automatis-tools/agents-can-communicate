import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAccChannel } from "../src/channel.mjs";

/**
 * A registration is a lease, and a lease nobody extends expires under a session
 * that is still running.
 *
 * Measured on a real 2.1.259 capture: the channel registered at 23:30:55 with
 * the 60s default, delivery was live and answered, and by 23:33 the same
 * session - same process, same socket, still serving - read as
 * `reachable: false`, so every later message fell back to the durable inbox.
 * Nothing was wrong with the endpoint; the record had simply gone stale.
 */
const registrationIn = dir => {
  const [file] = readdirSync(dir).filter(name => name.endsWith(".json"));
  return file === undefined ? null : JSON.parse(readFileSync(path.join(dir, file), "utf8"));
};

const channelOn = (t, dir, clock) => {
  const channel = createAccChannel({ endpointDir: dir, clientPid: 4242, leaseMs: 60_000,
    now: () => clock.value, write: () => {},
    routeReply: async () => {}, routeAck: async () => {} });
  t.after(() => channel.close());
  return channel;
};

test("a listening channel extends its lease instead of letting it expire", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-lease-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { value: 1_000_000 };
  const channel = channelOn(t, dir, clock);
  await channel.listen();

  const first = registrationIn(dir).leaseUntil;
  clock.value += 30_000;
  channel.renew();
  const second = registrationIn(dir).leaseUntil;

  assert.ok(Date.parse(second) > Date.parse(first),
    "a channel that is still serving must stay reachable, not expire under itself");
  assert.equal(Date.parse(second), clock.value + 60_000,
    "the extension is measured from now, not from the original registration");
});

test("renewing preserves the identity peers already resolved", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-lease-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { value: 2_000_000 };
  const channel = channelOn(t, dir, clock);
  await channel.listen();

  const before = registrationIn(dir);
  clock.value += 20_000;
  channel.renew();
  const after = registrationIn(dir);

  assert.equal(after.endpointId, before.endpointId, "a renewal is not a new endpoint");
  assert.equal(after.socketPath, before.socketPath);
  assert.equal(after.nonce, before.nonce, "rotating the nonce would lock out a connected peer");
  assert.equal(after.clientPid, before.clientPid);
});

test("a closed channel does not resurrect its registration", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-lease-closed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { value: 3_000_000 };
  const channel = channelOn(t, dir, clock);
  await channel.listen();
  const { registrationPath } = channel;

  channel.close();
  clock.value += 10_000;
  channel.renew();

  assert.equal(existsSync(registrationPath), false,
    "a closed endpoint must stay gone; re-writing it would advertise a socket nobody serves");
});
