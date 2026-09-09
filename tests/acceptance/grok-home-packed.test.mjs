import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Reverting clientContext to HOME/.grok makes installation report success in a
// directory the relocated client never reads. Exercise the installed CLI and
// its actual files; a direct adapter call already accepted grokHome correctly.
test("packed install, doctor, and uninstall use the selected Grok home", async t => {
  const place = await createPackedAcc(t);
  await place.setClientVersions({ grok: "1.0.24" });

  for (const setting of ["explicit", "empty", "unset"]) {
    await t.test(setting, async () => {
      const home = path.join(place.root, `${setting}-home`);
      const defaultHome = path.join(home, ".grok");
      const grokHome = setting === "explicit"
        ? path.join(place.root, "relocated grok") : defaultHome;
      const env = { HOME: home, CODEX_HOME: path.join(home, ".codex"),
        ACC_DATA_HOME: path.join(place.root, `${setting}-data`),
        GROK_HOME: setting === "explicit" ? grokHome : setting === "empty" ? "" : undefined };
      const foreign = path.join(grokHome, "hooks", "other.json");
      const foreignBytes = '{"hooks":{}}\n';
      await mkdir(path.dirname(foreign), { recursive: true });
      await writeFile(foreign, foreignBytes);
      const expected = [path.join(grokHome, "hooks", "acc.json"),
        path.join(grokHome, "hooks", "acc-hook.sh"),
        path.join(grokHome, "skills", "acc")];

      const installed = await place.acc(["install", "--adapter", "grok",
        "--delivery", "off"], env);
      assert.deepEqual(installed.failed, []);
      assert.equal(installed.operations[0].applied, true);
      assert.deepEqual(installed.operations[0].artifacts.map(item => item.path).sort(),
        [...expected].sort(), "installation did not target the client's selected Grok home");
      for (const file of expected) await stat(file);
      await stat(path.join(grokHome, "skills", "acc", "SKILL.md"));
      if (setting === "explicit") {
        await assert.rejects(stat(path.join(defaultHome, "hooks", "acc.json")), { code: "ENOENT" });
      }

      const doctor = await place.acc(["doctor"], env);
      assert.equal(doctor.adapters.find(item => item.adapterId === "grok").installed, true,
        "doctor did not inspect the selected Grok home");
      if (setting === "explicit") {
        const defaultDoctor = await place.acc(["doctor"], { ...env, GROK_HOME: "" });
        assert.equal(defaultDoctor.adapters.find(item => item.adapterId === "grok").installed,
          false, "doctor inferred registration from ownership instead of the selected home");
      }

      const removed = await place.acc(["uninstall", "--adapter", "grok"], env);
      assert.deepEqual(removed.failed, []);
      for (const file of expected) await assert.rejects(stat(file), { code: "ENOENT" });
      assert.equal(await readFile(foreign, "utf8"), foreignBytes,
        "uninstall disturbed another hook in the selected home");
      const after = await place.acc(["doctor"], env);
      assert.equal(after.adapters.find(item => item.adapterId === "grok").installed, false);
    });
  }
});
