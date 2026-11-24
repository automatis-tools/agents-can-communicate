import assert from "node:assert/strict";
import test from "node:test";

import { sameServicePath } from "../src/maintenance-host.mjs";

const home = "D:\\a\\_temp\\su\\temp\\acc-v02-packed-kfmkHy\\home\\.codex";
const expected = `${home}\\packages\\app-server-daemon\\current\\bin\\codex.exe`;

test("on Windows the daemon path Codex 0.165.0 reports, with both separators, is the expected one", () => {
  // `codex app-server daemon version`, windows-latest, 2026-11-24 (#449).
  const reported = `${home}\\packages/app-server-daemon\\current\\bin\\codex.exe`;
  assert.equal(sameServicePath(reported, expected, "win32-x64"), true);
  assert.equal(sameServicePath(expected, expected, "win32-x64"), true);
});

test("on Windows a reported path that names another file is still refused", () => {
  for (const reported of [`${home}\\packages/standalone\\current\\bin\\codex.exe`,
    `${home}\\packages/app-server-daemon\\current\\bin\\codex2.exe`, `${expected}\\..\\..\\codex.exe`,
    "C:\\other\\codex.exe", "", null, undefined, 42]) {
    assert.equal(sameServicePath(reported, expected, "win32-x64"), false, String(reported));
  }
});

test("on POSIX the reported path must match exactly: a backslash is part of a file name there", () => {
  const posix = "/home/me/.codex/packages/app-server-daemon/current/bin/codex";
  assert.equal(sameServicePath(posix, posix, "linux-x64"), true);
  assert.equal(sameServicePath("/home/me/.codex\\packages/app-server-daemon/current/bin/codex", posix,
    "linux-x64"), false);
  assert.equal(sameServicePath(`${posix}/`, posix, "darwin-arm64"), false);
});
