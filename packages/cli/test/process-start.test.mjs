import assert from "node:assert/strict";
import test from "node:test";
import { processStartedAt } from "../src/managed-runtime/activation.mjs";
import { inspectWorker } from "../src/managed-runtime/management-recovery.mjs";
import { parseStartTime, startTimeEnvironment } from "../src/managed-runtime/process-start.mjs";

const posix = { skip: process.platform === "win32" ? "POSIX ps start times" : false };
// Runs a check with this process in another zone; Node rereads TZ on assignment.
async function inZone(zone, check) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try { return await check(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

test("a UTC lstart value is read as UTC, and anything else is unreadable", () => {
  assert.equal(parseStartTime("Sun Nov  1 06:15:19 2026"), Date.UTC(2026, 10, 1, 6, 15, 19));
  assert.equal(parseStartTime("Sat Oct 31 23:59:59 2026\n"), Date.UTC(2026, 9, 31, 23, 59, 59));
  for (const value of ["", "Sun Nov 31 06:15:19 2026", "Sun Nov  1 24:00:00 2026", "Sun Foo  1 06:15:19 2026",
    "Sun Nov  1 06:15:19 2026 EST", "2026-11-01T06:15:19Z", null, 1793513719000]) {
    assert.equal(parseStartTime(value), null, String(value));
  }
  assert.equal(startTimeEnvironment({ PATH: "/bin", TZ: "America/Toronto" }).TZ, "UTC0");
  assert.equal(startTimeEnvironment({}).LC_ALL, "C");
});

// When daylight saving time ends, 01:30 happens twice in Toronto. ps without a
// UTC zone prints the same local text for both instants (seen on 2026-11-01).
test("a start time in the repeated daylight-saving hour names the instant ps measured", posix, async () => {
  const ps = async (file, args, options) => ({ stdout: options.env.TZ === "UTC0"
    ? "Sun Nov  1 06:30:00 2026\n" : "Sun Nov  1 01:30:00 2026\n" });
  const started = await inZone("America/Toronto", () => processStartedAt(4242, { platform: "darwin", run: ps }));
  assert.equal(started, Date.UTC(2026, 10, 1, 6, 30));
  const worker = await inZone("America/Toronto", () => inspectWorker(4242, { run: async (file, args, options) => ({
    stdout: `  501 ${(await ps(file, args, options)).stdout.trim()} /usr/local/bin/node /tmp/acc-update-worker.mjs /tmp\n` }) }));
  assert.equal(parseStartTime(worker.start), Date.UTC(2026, 10, 1, 6, 30));
});

test("the operating system's start time is read correctly in any local zone", posix, async () => {
  const expected = Date.now() - process.uptime() * 1000;
  for (const zone of ["Asia/Tokyo", "America/Toronto", "UTC"]) {
    const started = await inZone(zone, () => processStartedAt(process.pid));
    assert.ok(Math.abs(started - expected) < 5_000, `${zone}: ${started} vs ${expected}`);
    const worker = await inZone(zone, () => inspectWorker(process.pid));
    assert.ok(Math.abs(parseStartTime(worker.start) - expected) < 5_000, `${zone}: ${worker.start}`);
  }
});
