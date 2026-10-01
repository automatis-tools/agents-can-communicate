import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bakeSkillCommand, isShellWord } from "../src/index.mjs";

/**
 * How the skill names ACC's CLI shim.
 *
 * Quoted by default, because a managed data home is "Application Support" and
 * an unquoted path with a space splits. Antigravity CLI 1.2.12 needs the other
 * form: a command whose first word is quoted never matches an allow rule, so a
 * quoted wrapper always stops at an approval prompt (issue #214). The bare form
 * is therefore offered, and only for a path that is one shell word as written.
 */
async function bundle(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-bake-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, "skills", "acc", "SKILL.md");
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, "{{ACC}} status --json\nThen `{{ACC}} inbox`.\n");
  return { root, skill };
}

test("a path of portable filename characters is one shell word", () => {
  assert.equal(isShellWord("/Users/dana/.gemini/config/acc/acc-cli.sh"), true);
  assert.equal(isShellWord("/home/dana_2/.gemini/config/acc/acc-cli.sh"), true);
  for (const unsafe of ["/Users/Dana Smith/.gemini/config/acc/acc-cli.sh",
    "/tmp/a$b/acc-cli.sh", "/tmp/a'b/acc-cli.sh", "/tmp/a\"b/acc-cli.sh",
    "/tmp/a\\b/acc-cli.sh", "/tmp/a`b/acc-cli.sh", "/tmp/a;b/acc-cli.sh",
    "/tmp/a*b/acc-cli.sh", "/tmp/a(b/acc-cli.sh", "/tmp/~a/acc-cli.sh",
    "/tmp/a\tb/acc-cli.sh", "/tmp/a\nb/acc-cli.sh", "relative/acc-cli.sh",
    "C:\\Users\\dana\\acc-cli.sh", "", null, undefined]) {
    assert.equal(isShellWord(unsafe), false, JSON.stringify(unsafe));
  }
});

test("the default bake quotes the command, as every other client has it", async t => {
  const { root, skill } = await bundle(t);

  await bakeSkillCommand({ root, cliShim: "/home/dana/.gemini/config/acc/acc-cli.sh", platform: "linux" });

  assert.equal(await readFile(skill, "utf8"),
    "\"/home/dana/.gemini/config/acc/acc-cli.sh\" status --json\n"
    + "Then `\"/home/dana/.gemini/config/acc/acc-cli.sh\" inbox`.\n");
});

test("a bare bake names a one-word path without quotes", async t => {
  const { root, skill } = await bundle(t);

  await bakeSkillCommand({ root, cliShim: "/home/dana/.gemini/config/acc/acc-cli.sh", platform: "linux",
    bareWhenSafe: true });

  assert.equal(await readFile(skill, "utf8"),
    "/home/dana/.gemini/config/acc/acc-cli.sh status --json\n"
    + "Then `/home/dana/.gemini/config/acc/acc-cli.sh inbox`.\n");
});

test("a bare bake keeps the quotes a path needs to stay one word", async t => {
  const { root, skill } = await bundle(t);
  const shim = "/Users/Dana Smith/.gemini/config/acc/acc-cli.sh";

  await bakeSkillCommand({ root, cliShim: shim, bareWhenSafe: true, platform: "linux" });

  assert.equal(await readFile(skill, "utf8"),
    `"${shim}" status --json\nThen \`"${shim}" inbox\`.\n`);
});
