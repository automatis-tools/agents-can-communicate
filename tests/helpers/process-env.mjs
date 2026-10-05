import { mkdir } from "node:fs/promises";
import path from "node:path";

import { fakePath, platformEnv, writeFakeClient } from "./fake-client.mjs";

// General process tests exercise ACC's real binaries, not a developer's client
// startup or configuration. Version probes get fixed answers; client transport
// and installation tests keep their own purpose-specific fixtures.
export async function processFixtureEnv(base) {
  const home = path.join(base, "home");
  const clients = path.join(base, "clients");
  await Promise.all([home, clients].map(directory => mkdir(directory, { recursive: true })));
  await Promise.all(Object.entries({
    codex: "codex-cli 0.147.0", claude: "2.1.233 (Claude Code)",
    kimi: "kimi 0.36.1", gemini: "gemini 0.57.0", grok: "grok 1.0.13", agy: "1.2.7",
  }).map(([name, output]) => writeFakeClient(clients, name, { output })));
  return { ...platformEnv(), HOME: home, USERPROFILE: home, PATH: fakePath(clients),
    ACC_DATA_HOME: path.join(base, "data"), ACC_CONFIG_HOME: path.join(base, "config"),
    ACC_CACHE_HOME: path.join(base, "cache"), ACC_NO_UPDATE_CHECK: "1",
    GIT_DIR: "", GIT_WORK_TREE: "" };
}
