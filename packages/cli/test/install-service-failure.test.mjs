import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mainUrl = new URL("../src/main.mjs", import.meta.url).href;
const supported = process.platform === "darwin" && process.arch === "arm64";
for (const json of [false, true]) test(`actual main reports partial service failure in ${json ? "JSON" : "human output"}`,
  { skip: !supported }, async t => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cli-service-")));
    t.after(() => rm(home, { recursive: true, force: true }));
    const bin = path.join(home, "bin"), cli = path.join(bin, "codex"), codexHome = path.join(home, ".codex");
    const managed = path.join(codexHome, "packages/standalone/current/bin");
    await mkdir(bin); await mkdir(managed, { recursive: true });
    await writeFile(cli, `#!${process.execPath}\nconst args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("codex-cli 0.154.0");
else if (args === "app-server daemon --help") console.log("Commands:\\n  start Start\\n  stop Stop\\n  version Version");
else if (args === "app-server daemon start") { console.error("fixture startup failed"); process.exitCode = 1; }
else { console.error("unexpected fixture command"); process.exitCode = 2; }
`);
    await chmod(cli, 0o755); await symlink(cli, path.join(managed, "codex"));
    const driver = path.join(home, "driver.mjs");
    await writeFile(driver, `import { main } from ${JSON.stringify(mainUrl)};
process.exitCode = await main(["install", "--adapter", "codex", "--delivery", "actionable"${json ? ', "--json"' : ""}],
{ env: process.env, cwd: process.env.HOME, platform: process.platform, stdout: process.stdout, stderr: process.stderr });\n`);
    const output = await new Promise(resolve => execFile(process.execPath, [driver], {
      cwd: path.dirname(fileURLToPath(import.meta.url)), timeout: 15_000,
      env: { HOME: home, CODEX_HOME: codexHome, PATH: bin, ACC_DATA_HOME: path.join(home, "data") },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
    assert.equal(output.code, 4);
    assert.ok((await readFile(path.join(codexHome, "config.toml"), "utf8")).includes("acc"));
    if (json) {
      const payload = JSON.parse(output.stdout);
      assert.equal(payload.error.details.operations[0].applied, true);
      assert.equal(payload.error.details.failed.length, 1);
      assert.equal(payload.error.details.operations[0].nativeServiceSetup.state, "failed");
      assert.equal(output.stderr, "");
    } else {
      assert.equal(output.stdout, "");
      assert.match(output.stderr, /installed 1 adapter\(s\); 1 failed/);
      assert.match(output.stderr, /edited.*config.toml/);
      assert.match(output.stderr, /hooks/);
      assert.match(output.stderr, /retry acc install/);
    }
  });
