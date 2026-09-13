import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CODEX_INSTALLER, installCodexStandalone } from "../src/standalone-install.mjs";
import { downloadVerifiedInstaller } from "../../installer/src/verified-download.mjs";

const install = (plan, { fetch, ...options }) => installCodexStandalone(plan,
  { ...options, download: source => downloadVerifiedInstaller(source, { fetch }) });

const script = "#!/bin/sh\n# inert vendor script fixture\n";
const source = { ...CODEX_INSTALLER, sha256: createHash("sha256").update(script).digest("hex") };
const plan = { home: "/selected/home", codexHome: "/selected/codex", cliVersion: "0.154.0" };

test("verified installer runs once with selected homes, pinned version and private PATH", async () => {
  const calls = []; let file, execution;
  await install(plan, {
    source, env: { HOME: "/wrong/home", CODEX_HOME: "/wrong/codex", PATH: "/wrong/bin",
      CODEX_RELEASE: "latest", CODEX_NON_INTERACTIVE: "false", CODEX_INSTALL_DIR: "/wrong/install" },
    fetch: async (url, options) => {
      assert.equal(url, CODEX_INSTALLER.url); assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal); calls.push("download");
      return new Response(script);
    },
    beforeInstall: async () => { calls.push("validate"); },
    run: async (command, args, options) => {
      calls.push("install"); file = args[0];
      execution = { command, args, options, script: await readFile(file, "utf8"),
        mode: (await lstat(file)).mode & 0o777 };
      return { status: 0 };
    },
  });
  const { command, args, options } = execution;
  assert.equal(command, "/bin/sh");
  assert.deepEqual(args.slice(1), ["--release", "0.154.0"]);
  assert.equal(execution.script, script);
  assert.equal(execution.mode, 0o600);
  assert.equal(options.cwd, plan.home);
  assert.equal(options.env.HOME, plan.home); assert.equal(options.env.CODEX_HOME, plan.codexHome);
  assert.equal(options.env.CODEX_RELEASE, "0.154.0");
  assert.equal(options.env.CODEX_NON_INTERACTIVE, "1");
  assert.equal(options.env.CODEX_INSTALLER_USE_RELEASES_OPENAI_COM, "true");
  assert.equal(options.env.CODEX_INSTALL_DIR, "/selected/codex/packages/standalone/bin");
  assert.equal(options.env.PATH, "/selected/codex/packages/standalone/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.deepEqual(calls, ["download", "validate", "install"]);
  await assert.rejects(lstat(path.dirname(file)), { code: "ENOENT" });
});

for (const [name, response, reasonCode] of [
  ["checksum mismatch", () => new Response(`${script}tampered`), "prerequisite_integrity_failed"],
  ["oversized script", () => new Response("x".repeat(131_073)), "prerequisite_download_failed"],
  ["HTTP failure", () => new Response("failure", { status: 503 }), "prerequisite_download_failed"],
]) test(`${name} never executes a downloaded script`, async () => {
  let calls = 0;
  await assert.rejects(install(plan, { source, fetch: async () => response(),
    beforeInstall: async () => { calls += 1; }, run: async () => { calls += 1; return { status: 0 }; } }),
  { reasonCode });
  assert.equal(calls, 0);
});

test("a changed plan after download prevents execution", async () => {
  let ran = false;
  await assert.rejects(install(plan, { source, fetch: async () => new Response(script),
    beforeInstall: async () => { throw Object.assign(new Error("changed"), { reasonCode: "service_identity_changed" }); },
    run: async () => { ran = true; return { status: 0 }; } }), { reasonCode: "service_identity_changed" });
  assert.equal(ran, false);
});

test("vendor failure is reported without raw output and removes the temporary script", async () => {
  let file;
  await assert.rejects(install(plan, { source, fetch: async () => new Response(script),
    beforeInstall: async () => {}, run: async (_command, args) => {
      file = args[0]; return { status: 1, stderr: "PRIVATE VENDOR OUTPUT" };
    } }), error => error.reasonCode === "prerequisite_install_failed" && !error.message.includes("PRIVATE"));
  await assert.rejects(lstat(path.dirname(file)), { code: "ENOENT" });
});
