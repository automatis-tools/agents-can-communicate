import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { rewrittenCodexConfig, clientTables } from "../helpers/codex-config.mjs";

test("installed archive refresh and removal preserve client-written legacy TOML", async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ codex: "0.153.4" });
  const file = path.join(packed.clientHome, ".codex", "config.toml");
  const stateRoot = path.join(packed.dataHome, "acc");
  await mkdir(path.dirname(file), { recursive: true });
  for (const refresh of [false, true]) {
    await writeFile(file, rewrittenCodexConfig(stateRoot).replace(
      "[sandbox_workspace_write]", "[sandbox_workspace_write]\nnetwork_access = true"));
    if (refresh) {
      for (let i = 0; i < 2; i++) {
        const result = await packed.acc(["install", "--adapter", "codex", "--home", packed.clientHome]);
        assert.ok(result.operations[0].needsAction.some(line => line.includes("writable_roots")));
        const after = await readFile(file, "utf8");
        assert.ok(after.includes(clientTables), "archive refresh erased client values");
        assert.equal((after.match(/\[marketplaces.acc-local\]/g) ?? []).length, 1);
        assert.equal((after.match(/\[sandbox_workspace_write\]/g) ?? []).length, 1);
      }
    }
    await packed.acc(["uninstall", "--adapter", "codex", "--home", packed.clientHome]);
    const after = await readFile(file, "utf8");
    assert.ok(after.includes(clientTables), "archive removal erased client values");
    assert.ok(after.includes(`writable_roots = [${JSON.stringify(stateRoot)}]`));
    assert.match(after, /network_access = true/);
    assert.doesNotMatch(after, /\[marketplaces.acc-local\]|\[plugins\."agents-can-communicate@acc-local"\]/);
  }
});

test("recorded installed uninstall refuses ambiguous TOML before deleting any artifacts", async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ codex: "0.153.4" });
  const args = ["--adapter", "codex", "--home", packed.clientHome];
  await packed.acc(["install", ...args]);
  const config = path.join(packed.clientHome, ".codex", "config.toml");
  const installed = await readFile(config, "utf8");
  const ambiguous = installed.replace("enabled = true", 'enabled = true\nunknown_option = "preserve"');
  await writeFile(config, ambiguous);
  const before = await packed.snapshotClientFiles();
  const record = path.join(packed.dataHome, "acc", "installs.json");
  const ownership = await readFile(record, "utf8");

  const refused = await packed.accError(["uninstall", ...args]);
  assert.ok(refused, "ambiguous config did not refuse recorded uninstall");
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 4);
  assert.equal(error.details.failed[0].adapterId, "codex");
  assert.match(error.details.failed[0].error, /cannot safely edit Codex config: unknown key in owned table/);
  assert.ok(error.details.failed[0].error.includes(config));
  assert.deepEqual(await packed.snapshotClientFiles(), before,
    "recorded cleanup deleted client artifacts before ownership preflight");
  assert.equal(await readFile(record, "utf8"), ownership);

  // Removing the ambiguity permits a retry while preserving modified tree content.
  await writeFile(config, installed);
  const userFile = path.join(packed.clientHome, ".agents", "acc-local", "plugins",
    "agents-can-communicate", "user-note.txt");
  await writeFile(userFile, "user-owned content\n");
  await packed.acc(["uninstall", ...args]);
  assert.equal(await readFile(userFile, "utf8"), "user-owned content\n");
});
