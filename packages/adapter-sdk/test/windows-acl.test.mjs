import assert from "node:assert/strict";
import test from "node:test";

import { otherWindowsWriters, readWindowsAcls, windowsPrincipal } from "../src/windows-acl.mjs";

const USER = "S-1-5-21-1-2-3-1001";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const USERS = "S-1-5-32-545";
const FULL = 0x1f01ff;
const READ_EXECUTE = 0x1200a9;

const acl = (rules, owner = USER) => ({ owner, nullDacl: false, rules: rules.map(([sid, rights, extra = {}]) =>
  ({ sid, rights, type: "Allow", inheritOnly: false, ...extra })) });

test("a profile directory grants write only to the user, SYSTEM and Administrators", () => {
  assert.deepEqual(otherWindowsWriters(acl([[USER, FULL], [SYSTEM, FULL], [ADMINISTRATORS, FULL],
    [USERS, READ_EXECUTE]]), USER), []);
});

test("each write-capable right granted to another principal names that principal", () => {
  for (const right of [0x2, 0x4, 0x10, 0x40, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000]) {
    assert.deepEqual(otherWindowsWriters(acl([[USER, FULL], [USERS, READ_EXECUTE | right]]), USER), [USERS],
      `right 0x${right.toString(16)}`);
  }
});

test("rules that do not grant write to the object itself are not writers", () => {
  // CREATOR OWNER's full control applies only to what is created inside.
  assert.deepEqual(otherWindowsWriters(acl([[USER, FULL], ["S-1-3-0", 0x10000000, { inheritOnly: true }],
    [USERS, 0x2, { type: "Deny" }], [USERS, 0x100]]), USER), []);
});

test("an owner other than the user, SYSTEM or Administrators can rewrite the list, so it is a writer", () => {
  assert.deepEqual(otherWindowsWriters(acl([[USER, FULL]], "S-1-5-21-1-2-3-1002"), USER),
    ["S-1-5-21-1-2-3-1002"]);
  assert.deepEqual(otherWindowsWriters(acl([[USER, FULL]], ADMINISTRATORS), USER), []);
});

test("a null DACL grants everyone full access, though it lists no rule", () => {
  const open = { owner: USER, nullDacl: true, rules: [] };
  assert.deepEqual(otherWindowsWriters(open, USER), ["S-1-1-0"]);
  assert.equal(windowsPrincipal(open, "S-1-1-0"), "Everyone (S-1-1-0, no access list)");
  // A reader that did not say is not trusted to have seen a list.
  assert.deepEqual(otherWindowsWriters({ owner: USER, rules: [] }, USER), []);
});

test("an unreadable list is not a private one", () => {
  assert.deepEqual(otherWindowsWriters(null, USER), ["unreadable"]);
  assert.deepEqual(otherWindowsWriters(acl([[USER, FULL]]), null), ["unreadable"]);
});

test("one PowerShell run reads every path, by absolute path, without the caller's module path", async () => {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: JSON.stringify({ user: USER, paths: [
      { path: "C:\\a", owner: USER, rules: [{ sid: USER, rights: FULL, type: "Allow", inheritOnly: false }] },
      { path: "C:\\b", error: "denied" },
    ] }) };
  };
  const result = await readWindowsAcls(["C:\\a", "C:\\b"], { run,
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PSModulePath: "C:\\pwsh7\\Modules" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(JSON.parse(calls[0].options.env.ACC_ACL_PATHS).length, 2);
  assert.equal(Object.keys(calls[0].options.env).some(key => key.toLowerCase() === "psmodulepath"), false);
  assert.equal(result.user, USER);
  assert.deepEqual(result.acls.get("C:\\a").owner, USER);
  assert.equal(result.acls.get("C:\\a").nullDacl, true, "a reply without nullDacl: false is not a list");
  assert.equal(result.acls.get("C:\\b"), null);
});

test("Windows PowerShell answers when PowerShell 7 is not installed; no shell is no answer", async () => {
  const tried = [];
  const run = async file => {
    tried.push(file);
    if (file.endsWith("pwsh.exe")) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    return { stdout: JSON.stringify({ user: USER, paths: [{ path: "C:\\a", owner: USER, rules: [] }] }) };
  };
  const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" };
  assert.equal((await readWindowsAcls(["C:\\a"], { run, env })).user, USER);
  assert.equal(tried.at(-1), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const none = await readWindowsAcls(["C:\\a"], { env, run: async () => { throw new Error("no"); } });
  assert.equal(none.user, null);
  assert.equal(none.acls.get("C:\\a"), null);
});

test("a writer is named by its account where Windows resolves one", () => {
  const read = { owner: USER, ownerName: "HOST\\me", rules: [{ sid: USERS, name: "BUILTIN\\Users", rights: 0x2,
    type: "Allow", inheritOnly: false }, { sid: "S-1-5-21-9", name: null, rights: 0x2, type: "Allow", inheritOnly: false }] };
  assert.equal(windowsPrincipal(read, USERS), "BUILTIN\\Users (S-1-5-32-545)");
  assert.equal(windowsPrincipal(read, USER), "HOST\\me (S-1-5-21-1-2-3-1001)");
  assert.equal(windowsPrincipal(read, "S-1-5-21-9"), "S-1-5-21-9");
  assert.equal(windowsPrincipal(null, "unreadable"), "unreadable");
});

// The script itself, against a real directory. A temp directory need not be
// private: on the CI runner it inherits a write right for Users from D:\. So
// the test makes it private first, then grants Users a write right.
test("Windows reads a real access list and sees a write grant to Users", {
  skip: process.platform === "win32" ? false : "reads Windows access control lists",
}, async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "acc-acl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const icacls = (...args) => promisify(execFile)("icacls.exe", [dir, ...args]);
  const first = await readWindowsAcls([dir]);
  assert.match(first.user ?? "", /^S-1-5-21-/);
  assert.notEqual(first.acls.get(dir), null);
  await icacls("/inheritance:r", "/grant:r", `*${first.user}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F");
  const closed = await readWindowsAcls([dir]);
  assert.deepEqual(otherWindowsWriters(closed.acls.get(dir), closed.user), [], JSON.stringify(closed.acls.get(dir)));
  await icacls("/grant", "*S-1-5-32-545:(W)");
  const opened = await readWindowsAcls([dir]);
  assert.ok(otherWindowsWriters(opened.acls.get(dir), opened.user).includes(USERS),
    JSON.stringify(opened.acls.get(dir)));
  assert.match(windowsPrincipal(opened.acls.get(dir), USERS), /Users \(S-1-5-32-545\)$/);
  // No access list at all: everyone has full access, and no rule says so.
  await promisify(execFile)("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$a = Get-Acl -LiteralPath $env:ACC_DIR; $a.SetSecurityDescriptorSddlForm('D:NO_ACCESS_CONTROL'); "
      + "Set-Acl -LiteralPath $env:ACC_DIR -AclObject $a"], { env: { ...process.env, ACC_DIR: dir } });
  const open = await readWindowsAcls([dir]);
  assert.deepEqual(otherWindowsWriters(open.acls.get(dir), open.user), ["S-1-1-0"], JSON.stringify(open.acls.get(dir)));
});
