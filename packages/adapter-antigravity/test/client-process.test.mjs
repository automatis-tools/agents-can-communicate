import assert from "node:assert/strict";
import test from "node:test";

import { createAntigravityAdapter } from "../src/adapter.mjs";
import { desktopServer, identifyClientProcess, isAgy } from "../src/client-process.mjs";
import { nativeActivationHint } from "../src/native-delivery.mjs";

// The command line Antigravity 2.19.1 started its language server with on
// 2026-10-04, the token and bridge secrets replaced.
const DESKTOP = "/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone "
  + "--override_ide_name antigravity --subclient_type hub --override_ide_version 2.19.1 "
  + "--override_user_agent_name antigravity --https_server_port 0 --csrf_token <token> "
  + "--app_data_dir antigravity --api_server_url https://generativelanguage.googleapis.com "
  + "--enable_sidecars --host_bridge_url=http://127.0.0.1:55326 --host_bridge_token=<bridge>";

test("the desktop app's language server is the desktop client, at the version it names", () => {
  assert.deepEqual(identifyClientProcess({ comm: "/Applications/Antigravity.app/Contents/Resources/bin/"
    + "language_server", args: DESKTOP }), { certificationName: "antigravity-desktop", version: "2.19.1" });
  assert.equal(desktopServer(DESKTOP).executable,
    "/Applications/Antigravity.app/Contents/Resources/bin/language_server");
});

test("a bundle path with a space and the --flag=value form are read the same", () => {
  const spaced = DESKTOP.replace("/Applications/Antigravity.app", "/Applications/Antigravity Beta.app")
    .replace("--app_data_dir antigravity", "--app_data_dir=antigravity");
  assert.deepEqual(identifyClientProcess({ comm: "language_server", args: spaced }),
    { certificationName: "antigravity-desktop", version: "2.19.1" });
});

test("a desktop server whose version is unreadable is still the desktop client", () => {
  assert.deepEqual(identifyClientProcess({ comm: "language_server",
    args: DESKTOP.replace("--override_ide_version 2.19.1 ", "") }), { certificationName: "antigravity-desktop" });
  assert.deepEqual(identifyClientProcess({ comm: "language_server",
    args: DESKTOP.replace("2.19.1", "next") }), { certificationName: "antigravity-desktop" });
});

test("other language servers and other programs are left to the runner's own match", () => {
  for (const args of [
    // The IDE's server has its own name and data directory.
    "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/"
      + "language_server_macos_arm --csrf_token x --app_data_dir antigravity-ide",
    DESKTOP.replace("--standalone ", ""),
    DESKTOP.replace("--app_data_dir antigravity", "--app_data_dir antigravity-cli"),
    DESKTOP.replace("/Applications/Antigravity.app/Contents/Resources/bin/language_server", "language_server"),
    "/Users/me/.local/bin/agy",
    "node /data/acc-hook.mjs antigravity PreInvocation",
  ]) {
    assert.equal(identifyClientProcess({ comm: "x", args }), null, args);
  }
  assert.equal(identifyClientProcess({ comm: "x" }), null);
});

test("the adapter declares the desktop app beside Antigravity CLI", () => {
  const adapter = createAntigravityAdapter();
  assert.deepEqual(adapter.client.variants, [{ certificationName: "antigravity-desktop",
    displayName: "Antigravity" }]);
  assert.equal(adapter.identifyClientProcess, identifyClientProcess);
});

test("agy is recognised by name, bare, by path and as a Windows image", () => {
  assert.equal(isAgy(["agy"]), true);
  assert.equal(isAgy(["/Users/me/.local/bin/agy", "--add-dir", "."]), true);
  assert.equal(isAgy(["C:\\Users\\me\\AppData\\Local\\agy\\AGY.EXE"]), true);
  assert.equal(isAgy(DESKTOP.split(" ")), false);
  assert.equal(isAgy([]), false);
});

test("a desktop conversation is never asked to start the CLI's relay", async () => {
  const hint = await nativeActivationHint({ event: { sessionId: "f7aaa891-7182-4b6d-9123-dbf2df9561b9" },
    nativeBinding: { state: "degraded", reasonCode: "handshake_failed", modes: [] },
    runtimeDir: "/nonexistent", clientPid: 77034, env: { HOME: "/Users/me" },
    argvOf: async () => DESKTOP.split(" "), isAlive: () => true });
  assert.equal(hint, null);
});
