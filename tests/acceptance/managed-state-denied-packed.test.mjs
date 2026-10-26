import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);

// #316, through the installed launcher and the generation it admits: a process
// that may not write ACC's runtime directory was told an update was unfinished.
// On macOS its owner can make the directory immutable, and admission's fchmod
// and mkdir then fail with EPERM as they did inside a client sandbox.
const skip = process.platform === "darwin" ? false
  : "chflags uchg is macOS's; the denial's classification and texts are unit-tested everywhere";

test("an installed ACC that may not write its state names the denial, not an update", { skip }, async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ grok: "1.0.25" });
  await f.acc(["install", "--adapter", "grok"]);
  const root = path.join(f.dataHome, "acc", "runtime");
  // Cleared before the fixture's own cleanup, which has to remove the directory.
  await run("chflags", ["uchg", root]);
  let status, doctor;
  try {
    status = JSON.parse((await f.accError(["status"])).stdout);
    doctor = await f.acc(["doctor"]);
  } finally { await run("chflags", ["nouchg", root]); }

  assert.equal(status.error.code, 4);
  assert.equal(status.error.details.reasonCode, "state_access_denied");
  assert.match(status.error.message, /cannot write ACC's state: fchmod \S+\/acc\/runtime was refused \(EPERM\)/);
  assert.match(status.error.message, /the runtime is ready and no update is pending/);
  assert.doesNotMatch(status.error.message, /retry after the update|run acc update/);
  assert.equal(doctor.workspaceInspection, "state_access_denied");
  assert.equal(doctor.update.phase, "ready");
  assert.doesNotMatch(JSON.stringify(doctor.remediation), /acc update/);
});
