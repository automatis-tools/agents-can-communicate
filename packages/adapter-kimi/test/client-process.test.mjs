import assert from "node:assert/strict";
import test from "node:test";

import { resolveClient } from "../../hook-runner/src/client-pid.mjs";
import { clientVersionOf, identifyClientProcess } from "../src/client-process.mjs";

const entry = (comm, ppid = 1) => ({ comm, args: comm, ppid });

test("Web hooks resolve their packaged server parent rather than an unrelated kimi process", () => {
  const table = new Map([[10, entry("node", 20)], [20, entry("kimi-code", 30)],
    [30, entry("kimi")]]);
  const found = resolveClient({ table, from: 10, command: "kimi", identify: identifyClientProcess });
  assert.equal(found.pid, 20);
  assert.equal(found.certificationName, "kimi");
});

test("other processes and lookalike names are not Web clients", () => {
  for (const comm of ["node", "kimi-server-v2", "kimi-code-helper", "not-kimi-code"]) {
    assert.equal(identifyClientProcess({ comm }), null);
  }
  assert.equal(identifyClientProcess({ comm: "/opt/kimi-code.exe" }).certificationName, "kimi");
});

test("a missing or stale server registry yields no invented client version", async () => {
  assert.equal(await clientVersionOf({ pid: 999_999_999,
    env: { KIMI_CODE_HOME: "/definitely/missing/kimi-home" } }), null);
});
