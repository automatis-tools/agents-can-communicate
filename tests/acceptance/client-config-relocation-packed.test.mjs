import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// #148: Claude Code, Gemini CLI and Kimi Code each move their configuration with
// their own variable, and none reads XDG_CONFIG_HOME. ACC wrote these three
// integrations under the default directory, where a relocated client never
// reads them. Exercise the installed CLI and the files it writes.
const CLIENTS = [
  { adapterId: "claude_code", variable: "CLAUDE_CONFIG_DIR", marker: dir => path.join(dir, "settings.json"),
    relocated: root => path.join(root, "relocated claude"), fallback: home => path.join(home, ".claude") },
  { adapterId: "gemini_cli", variable: "GEMINI_CLI_HOME", marker: dir => path.join(dir, ".gemini", "settings.json"),
    relocated: root => path.join(root, "relocated gemini"), fallback: home => home,
    reported: dir => path.join(dir, ".gemini") },
  { adapterId: "kimi", variable: "KIMI_CODE_HOME", marker: dir => path.join(dir, "config.toml"),
    relocated: root => path.join(root, "relocated kimi"), fallback: home => path.join(home, ".kimi-code") },
];

// Directories under `root` that hold nothing: what an uninstall left behind.
async function emptyDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entries === null) return [];
  const nested = await Promise.all(entries.filter(entry => entry.isDirectory())
    .map(entry => emptyDirectories(path.join(root, entry.name))));
  const below = nested.flat();
  return entries.length === 0 ? [root] : below;
}

test("packed install, doctor, and uninstall follow each client's relocation variable", async t => {
  const place = await createPackedAcc(t);
  await place.setClientVersions({ claude: "2.1.316", codex: "0.166.0", gemini: "0.57.0", kimi: "2.4.1" });

  for (const client of CLIENTS) {
    for (const setting of ["explicit", "relative", "unset"]) {
      await t.test(`${client.adapterId} ${setting}`, async () => {
        const home = path.join(place.root, `${client.adapterId}-${setting}-home`);
        const defaultDir = client.fallback(home);
        const dir = setting === "explicit" ? client.relocated(place.root) : defaultDir;
        const env = { HOME: home, CODEX_HOME: path.join(home, ".codex"),
          ACC_DATA_HOME: path.join(place.root, `${client.adapterId}-${setting}-data`),
          [client.variable]: setting === "explicit" ? dir : setting === "relative" ? "relative/dir" : undefined };

        const installed = await place.acc(["install", "--adapter", client.adapterId, "--delivery", "off"], env);
        assert.deepEqual(installed.failed, []);
        assert.equal(installed.operations[0].applied, true);
        await stat(client.marker(dir));
        if (setting === "explicit") {
          await assert.rejects(stat(client.marker(defaultDir)), { code: "ENOENT" },
            "installation wrote beside the relocated client");
        }

        const doctor = await place.acc(["doctor"], env);
        const entry = doctor.adapters.find(item => item.adapterId === client.adapterId);
        assert.equal(entry.installed, true, "doctor did not inspect the client's directory");
        assert.deepEqual(entry.configHome, { path: (client.reported ?? (value => value))(dir),
          variable: setting === "explicit" ? client.variable : null });
        if (setting === "explicit") {
          const moved = await place.acc(["doctor"], { ...env, [client.variable]: undefined });
          assert.equal(moved.adapters.find(item => item.adapterId === client.adapterId).installed, false,
            "doctor inferred registration from ownership instead of the client's directory");
          assert.ok(moved.adapters.find(item => item.adapterId === client.adapterId).remediation
            .some(line => line.includes("was installed outside")), "doctor did not name the moved installation");
        }

        const removed = await place.acc(["uninstall", "--adapter", client.adapterId], env);
        assert.deepEqual(removed.failed, []);
        if (setting === "explicit") {
          assert.deepEqual((await emptyDirectories(dir)).filter(item => item !== dir), [],
            "uninstall left the directories it created in the relocated client");
        }
        const after = await place.acc(["doctor"], env);
        assert.equal(after.adapters.find(item => item.adapterId === client.adapterId).installed, false);
      });
    }
  }
});
