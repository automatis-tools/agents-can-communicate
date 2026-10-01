import assert from "node:assert/strict";
import test from "node:test";

import { parseClientVersion, probeClientVersion } from "../src/client-version.mjs";

test("the hook process parses client-shaped version banners", () => {
  assert.equal(parseClientVersion("codex-cli 0.152.0"), "0.152.0");
  assert.equal(parseClientVersion("2.1.252 (Claude Code)"), "2.1.252");
  assert.equal(parseClientVersion("build from source"), null);
});

test("session attach probes the actual executable instead of a manifest constant", async () => {
  const version = await probeClientVersion({
    client: { command: process.execPath, versionArgs: ["--version"] },
  });

  assert.equal(version, process.versions.node);
});

// npm installs a client on Windows as a .cmd that runs node on the package's
// script. Asking it for --version starts cmd.exe, node and, for Codex, the
// native binary node starts: 11.5 s on a fresh windows-latest runner, and a
// share of four cores whenever several sessions start. The package that .cmd
// runs names its version, and that is what --version would print.
test("windows: an npm .cmd client's version is read from the package it runs", async () => {
  const { npmShimVersion } = await import("../src/client-version.mjs");
  const prefix = "C:\\Users\\dana\\AppData\\Roaming\\npm";
  const files = new Map([
    [`${prefix}\\codex.cmd`, "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n"
      + ":start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n"
      + "  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\n"
      + "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  "
      + "\"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n"],
    [`${prefix}\\node_modules\\@openai\\codex\\package.json`,
      JSON.stringify({ name: "@openai/codex", version: "0.159.2", bin: { codex: "bin/codex.js" } })],
    [`${prefix}\\stray.cmd`, "@echo off\r\necho 1.0.0\r\n"],
    [`${prefix}\\other.cmd`, "\"%dp0%\\node_modules\\other\\cli.js\" %*\r\n"],
    [`${prefix}\\node_modules\\other\\package.json`,
      JSON.stringify({ name: "other", version: "9.9.9", bin: { other: "not-this.js" } })],
  ]);
  const readFile = async file => {
    if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
    return files.get(file);
  };

  assert.equal(await npmShimVersion(`${prefix}\\codex.cmd`, { readFile }), "0.159.2");
  assert.equal(await npmShimVersion(`${prefix}\\stray.cmd`, { readFile }), null,
    "a .cmd that runs no package script has no package version");
  assert.equal(await npmShimVersion(`${prefix}\\other.cmd`, { readFile }), null,
    "a package whose bin is another script is not the one the .cmd runs");
});
