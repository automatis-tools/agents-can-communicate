import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../helpers/run-process.mjs";

// A process can exit while its output pipe still has data to deliver. A helper
// process holding the pipe open past the exit makes that window deterministic.
const exitsBeforeOutputArrives = `
  const { spawn } = require("node:child_process");
  spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('late'), 200)"],
    { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
`;

test("the result waits for the child's output to end, not only for its exit", async () => {
  const { code, stdout } = await runProcess(["-e", exitsBeforeOutputArrives], { timeoutMs: 30_000 });
  assert.equal(code, 0);
  assert.equal(stdout, "late");
});
