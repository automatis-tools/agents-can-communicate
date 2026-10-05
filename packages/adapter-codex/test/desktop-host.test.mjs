import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { desktopAppServer, embeddedHost } from "../src/embedded-host.mjs";
import { nativeActivationHint } from "../src/native-delivery.mjs";

// The Codex app (inside ChatGPT.app 26.928, bundled codex 0.159.2) runs every
// window on a private app server over stdio, never the shared daemon, because
// it always passes config overrides (openai/codex#41014). Its threads run
// ACC's hooks with that server as their client process; read 2026-10-04.
const DESKTOP = ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "app-server", "-c", "features.code_review=true", "-c", "codex_app.enabled=true"];

test("the Codex app's private app server is told from the daemon and from a TUI", () => {
  assert.equal(desktopAppServer(DESKTOP), true);
  assert.equal(desktopAppServer(["/Applications/Codex.app/Contents/Resources/codex", "app-server"]), true);
  // The shared daemon listens; a TUI has no app-server subcommand.
  assert.equal(desktopAppServer(["/Users/me/.codex/packages/standalone/releases/0.160.0/bin/codex",
    "app-server", "--listen", "unix://", "--managed-daemon"]), false);
  assert.equal(desktopAppServer(["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/"
    + "Contents/MacOS/codex", "app-server", "--listen", "unix://"]), false);
  assert.equal(desktopAppServer(["codex", "app-server"]), false, "outside an app bundle");
  assert.equal(desktopAppServer(["codex"]), false);
  assert.equal(desktopAppServer(["/Applications/Other.app/Contents/MacOS/other", "app-server"]), false);
});

test("a thread on the Codex app's server is embedded, with no option to blame", async () => {
  assert.deepEqual(await embeddedHost(74775, async () => DESKTOP), { launchOption: null, desktop: true });
  assert.deepEqual(await embeddedHost(1, async () => ["codex", "--search"]), { launchOption: "--search" });
});

test("a Codex app thread is told once that its app runs it apart, with nothing to change",
  async t => {
    const runtimeDir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cx-desktop-")));
    t.after(() => rm(runtimeDir, { recursive: true, force: true }));
    const ask = () => nativeActivationHint({ event: { sessionId: "thread-1", cwd: "/work" },
      nativeBinding: { state: "degraded", reasonCode: "client_session_embedded", modes: [] },
      runtimeDir, clientPid: 74775, env: {}, argvOf: async () => DESKTOP });

    const notice = await ask();

    assert.match(notice.line, /Codex app/);
    assert.match(notice.line, /next prompt/);
    assert.doesNotMatch(notice.line, /daemon start|new Codex chat/);
    assert.match(notice.userMessage, /Codex app/);
    assert.doesNotMatch(notice.userMessage, /daemon start|new Codex chat/);
    assert.ok(Buffer.byteLength(notice.line) <= 512 && Buffer.byteLength(notice.userMessage) <= 512);
    assert.equal(await ask(), null, "one delivered notice per chat");
  });
