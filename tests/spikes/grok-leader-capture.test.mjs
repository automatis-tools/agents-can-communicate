import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PROTOCOL_CONTRACT, buildGrokCapture, inspectGrokSurface }
  from "../../scripts/spikes/grok-leader-capture.mjs";
import { validateCapture } from "../../scripts/spikes/delivery-capture.mjs";
import { runProcess } from "../helpers/claude-channel.mjs";

const script = fileURLToPath(new URL("../../scripts/spikes/grok-leader-capture.mjs",
  import.meta.url));

const HELP = {
  "--version": "grok 1.0.13 (5e9a58528b76) [stable]\n",
  "--help": "Grok Build TUI\n      --leader-socket <PATH>\n          Use a custom leader socket path\n",
  "agent --help": "      --leader\n          Connect to a shared leader process\n      --no-leader\n",
  "agent leader --help": "Run as the shared leader process for other clients\n"
    + "      --leader-socket <PATH>\n",
};
const fakeExec = (command, args) => HELP[args.join(" ")] ?? "";

test("the public surface is inspected read-only and reports no injection path", () => {
  const calls = [];
  const surface = inspectGrokSurface({ command: "grok", exec: (command, args) => {
    calls.push(args.join(" "));
    return fakeExec(command, args);
  } });
  assert.deepEqual(calls, ["--version", "--help", "agent --help", "agent leader --help"]);
  assert.deepEqual(surface, { version: "1.0.13", leaderSocketFlag: true, leaderClientFlag: true,
    sharedLeaderMode: true, injectionPath: false });
  assert.equal(Object.isFrozen(surface), true);
});

test("the capture is an honest fail with a measured timestamp", () => {
  const surface = inspectGrokSurface({ exec: fakeExec });
  const capture = buildGrokCapture(surface, { platform: "darwin-arm64",
    observedAt: "2026-09-02T12:00:00.000Z" });
  assert.deepEqual(validateCapture(capture), capture);
  assert.equal(capture.result, "fail");
  assert.equal(capture.launchMode, "no-client-launched");
  assert.equal(capture.protocolContract, PROTOCOL_CONTRACT);
  assert.equal(capture.fixture, "grok-1.0.13-leader");
  for (const branch of ["idle", "busy", "reply", "duplicate", "fallback"]) {
    assert.equal(capture[branch], "unobserved");
  }
  assert.match(capture.limitations[0], /no addressed message injection/);
  assert.match(capture.limitations.at(-1), /not observed/);
  assert.throws(() => buildGrokCapture({ ...surface, version: "1.0.13-beta.1" },
    { platform: "darwin-arm64", observedAt: "2026-09-02T12:00:00.000Z" }),
  /capture version is a stable semantic version/);
});

test("the command prints one capture from a fake client and refuses an unavailable one",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "acc-grok-spike-"));
    const fake = path.join(dir, "fake-grok.mjs");
    writeFileSync(fake, `#!/usr/bin/env node
const help = ${JSON.stringify(HELP)};
process.stdout.write(help[process.argv.slice(2).join(" ")] ?? "");
`, { mode: 0o700 });
    chmodSync(fake, 0o700);
    const broken = path.join(dir, "broken-grok.mjs");
    writeFileSync(broken, "process.stdout.write('grok dev-build\\n');\n", { mode: 0o700 });
    chmodSync(broken, 0o700);
    try {
      const run = await runProcess([script], { env: { ACC_GROK_SPIKE_COMMAND: fake } });
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(validateCapture(run.result), run.result);
      assert.equal(run.result.version, "1.0.13");
      assert.match(run.result.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const unavailable = await runProcess([script], { env: { ACC_GROK_SPIKE_COMMAND: broken } });
      assert.equal(unavailable.code, 1);
      assert.match(unavailable.stderr, /nothing to capture/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
