import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import nodeTest from "node:test";

import { installAntigravity, uninstallAntigravity } from "../src/install.mjs";
import { ANY_POLICY, agyHome } from "./agy-home.mjs";
import { NO_ALLOW_RULE_ON_WINDOWS } from "../../../tests/helpers/platform-scope.mjs";

const test = (name, ...rest) => { const fn = rest.pop(); const options = rest[0] ?? {};
  return nodeTest(name, { ...options, skip: options.skip ?? NO_ALLOW_RULE_ON_WINDOWS }, fn); };

/**
 * The allow rule that lets a woken Antigravity session answer unattended.
 *
 * Antigravity CLI asks before every shell command. A live push woke an idle
 * session on 1.2.12, and its first ACC command then waited at an approval
 * prompt with nobody there; the receipt stayed `offered` (issue #214). One rule
 * under `permissions.allow` removes the prompt: `command(<wrapper>)`, a
 * one-word prefix for every command whose first word is the unquoted wrapper.
 *
 * The user decided on 2026-09-27 that ACC always writes it: every install of
 * this adapter, whatever the delivery policy, with nobody asked. The file is
 * still the operator's. ACC adds that one rule, keeps every other byte, and
 * uninstall takes back only what it added.
 */

test("install adds one prefix rule for the unquoted wrapper and keeps the rest", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);

  const result = await installAntigravity(fixture.context);

  const expected = { ...fixture.theirs, permissions: {
    allow: [...fixture.theirs.permissions.allow, `command(${fixture.wrapper})`] } };
  // Two-space JSON with a trailing newline, as the client writes it.
  assert.equal(await fixture.read(), `${JSON.stringify(expected, null, 2)}\n`);
  assert.equal(result.changes.includes(fixture.settings), true,
    "the edited settings file is missing from what install reports it changed");
  assert.equal(result.diagnostics.some(line => line.includes(fixture.rule)
    && /restart/.test(line)), true, "install must say the rule loads when agy starts again");
});

test("a second install changes nothing", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  await installAntigravity(fixture.context);
  const once = await fixture.read();

  const again = await installAntigravity(fixture.context);

  assert.equal(await fixture.read(), once);
  assert.equal(again.changes.includes(fixture.settings), false);
  assert.equal(JSON.parse(once).permissions.allow.filter(rule => rule === fixture.rule).length, 1);
});

test("uninstall takes back exactly the rule ACC added", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  const before = await fixture.read();
  await installAntigravity(fixture.context);

  const result = await uninstallAntigravity(fixture.context);

  assert.equal(await fixture.read(), before);
  assert.equal(result.changes.includes(fixture.settings), true);
});

test("uninstall leaves no copy of ACC's rule, however many were added after it", async t => {
  // A copy in the same words cannot be told from ACC's own: the client has
  // accumulated duplicate grants across reloads itself (vendor changelog). Taking
  // one copy back left the other, and ACC commands still ran unasked after
  // uninstall (review of #218). A rule the operator had before ACC came is never
  // claimed, so it is untouched.
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  const before = await fixture.read();
  await installAntigravity(fixture.context);
  const installed = JSON.parse(await fixture.read());
  await fixture.write({ ...installed, permissions: { ...installed.permissions,
    allow: [...installed.permissions.allow, "command(git status)", fixture.rule] } });

  await uninstallAntigravity(fixture.context);

  const after = JSON.parse(await fixture.read());
  assert.equal(after.permissions.allow.includes(fixture.rule), false,
    "a copy of ACC's rule survived uninstall");
  assert.deepEqual(after.permissions.allow,
    [...JSON.parse(before).permissions.allow, "command(git status)"]);
});

test("a rule the operator already has stays theirs through install and uninstall", async t => {
  // The bare form ACC writes, and the quoted one-word form 1.2.12 was captured
  // matching: either one already allows every ACC command.
  for (const form of ["bare", "quoted"]) {
    const fixture = await agyHome(t);
    const own = form === "bare" ? fixture.rule : `command("${fixture.wrapper}")`;
    await fixture.write({ ...fixture.theirs, permissions: { allow: [own] } });
    const before = await fixture.read();

    await installAntigravity(fixture.context);
    // Only the rule for the command that starts live delivery is ACC's to add.
    assert.deepEqual(JSON.parse(await fixture.read()).permissions.allow, [own, fixture.relay],
      `${form}: install added a second wrapper rule`);
    await uninstallAntigravity(fixture.context);
    assert.equal(await fixture.read(), before, `${form}: uninstall took the operator's rule`);
  }
});

for (const [label, decision] of ANY_POLICY) {
  test(`the rule does not depend on delivery: ${label}`, async t => {
    const fixture = await agyHome(t);
    await fixture.write(fixture.theirs);

    await installAntigravity({ ...fixture.context, ...decision });

    assert.deepEqual(JSON.parse(await fixture.read()).permissions.allow,
      [...fixture.theirs.permissions.allow, fixture.rule]);
  });
}

test("the next install puts back a rule removed by hand, and still owns it", async t => {
  // Always on: the only way to keep the rule out is to uninstall ACC.
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  const before = await fixture.read();
  await installAntigravity(fixture.context);
  const withRule = await fixture.read();
  await fixture.write(fixture.theirs);

  const result = await installAntigravity(fixture.context);

  assert.equal(await fixture.read(), withRule);
  assert.equal(result.changes.includes(fixture.settings), true);
  await uninstallAntigravity(fixture.context);
  assert.equal(await fixture.read(), before);
});

test("a settings file that did not exist is created, then removed again", async t => {
  const fixture = await agyHome(t);

  await installAntigravity(fixture.context);
  assert.equal(await fixture.read(),
    `${JSON.stringify({ permissions: { allow: [fixture.rule, fixture.relay] } }, null, 2)}\n`);

  await uninstallAntigravity(fixture.context);
  assert.equal(await fixture.exists(), false, "uninstall left the settings file ACC created");
});

test("a settings file the operator put in place of ACC's is never taken for ACC's", async t => {
  // ACC created the file; the operator deleted it and wrote their own. The
  // next install adds the rule to a file that already exists, so it records no
  // file of its own - and uninstall leaves the operator's file. Carrying the
  // first install's "created" over deleted it as empty (review of #218).
  const fixture = await agyHome(t);
  await installAntigravity(fixture.context);
  await fixture.write({});
  const theirs = await fixture.read();

  await installAntigravity(fixture.context);
  await uninstallAntigravity(fixture.context);

  assert.equal(await fixture.exists(), true, "uninstall deleted the operator's settings file");
  assert.deepEqual(JSON.parse(await fixture.read()), JSON.parse(theirs));
});

test("containers ACC created go only while nothing of the operator's is in them", async t => {
  const fixture = await agyHome(t);
  await fixture.write({ colorScheme: "dark" });
  const before = await fixture.read();
  await installAntigravity(fixture.context);

  await uninstallAntigravity(fixture.context);
  assert.equal(await fixture.read(), before);

  // The operator adds a rule of their own beside ACC's after install.
  await installAntigravity(fixture.context);
  const current = JSON.parse(await fixture.read());
  current.permissions.allow.push("command(git status)");
  await fixture.write(current);
  await uninstallAntigravity(fixture.context);
  assert.deepEqual(JSON.parse(await fixture.read()),
    { colorScheme: "dark", permissions: { allow: ["command(git status)"] } });
});

test("empty containers and an empty file the operator had are left in place", async t => {
  for (const theirs of ["{}\n", "{\n  \"permissions\": {}\n}\n",
    "{\n  \"permissions\": {\n    \"allow\": []\n  }\n}\n"]) {
    const fixture = await agyHome(t);
    await fixture.write(theirs);

    await installAntigravity(fixture.context);
    await uninstallAntigravity(fixture.context);

    assert.equal(await fixture.exists() ? await fixture.read() : null, theirs,
      "uninstall removed a container or a file that was the operator's before ACC came");
  }
});

test("uninstall ends ACC's claim even when its rule was already gone", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  await installAntigravity(fixture.context);
  await fixture.write(fixture.theirs);
  await uninstallAntigravity(fixture.context);

  // Added back later in the same words, by the operator this time.
  await fixture.write({ ...fixture.theirs, permissions: { allow: [fixture.rule] } });
  const theirsNow = await fixture.read();
  await uninstallAntigravity(fixture.context);

  assert.equal(await fixture.read(), theirsNow);
});

const UNREADABLE = [
  ["not JSON", "{ \"colorScheme\": \"dark\",\n"],
  ["a list at the top", "[]\n"],
  ["permissions that is not an object", "{\n  \"permissions\": true\n}\n"],
  ["permissions.allow that is not a list", "{\n  \"permissions\": {\n    \"allow\": \"x\"\n  }\n}\n"],
];

for (const [label, text] of UNREADABLE) {
  test(`a settings file ACC cannot read is never rewritten: ${label}`, async t => {
    const fixture = await agyHome(t);
    await fixture.write(text);

    const result = await installAntigravity(fixture.context);

    assert.equal(await fixture.read(), text);
    assert.equal(result.needsAction?.some(line => line.includes(fixture.settings)
      && line.includes(fixture.rule)), true,
    "the operator is not told why ACC commands will still wait for approval");
    await uninstallAntigravity(fixture.context);
    assert.equal(await fixture.read(), text);
  });
}

test("an uninstall that cannot read the file keeps ACC's claim for the next one", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  const before = await fixture.read();
  await installAntigravity(fixture.context);
  const withRule = await fixture.read();
  await fixture.write("{ broken");

  const result = await uninstallAntigravity(fixture.context);
  assert.equal(await fixture.read(), "{ broken");
  assert.equal(result.needsAction?.some(line => line.includes(fixture.settings)), true);

  // Repaired by the operator: the next uninstall finds the claim and finishes.
  await fixture.write(withRule);
  await uninstallAntigravity(fixture.context);
  assert.equal(await fixture.read(), before);
});

test("ACC's claim is kept in its own data home, never in the client's file", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);

  await installAntigravity(fixture.context);

  const settings = JSON.parse(await fixture.read());
  assert.deepEqual(Object.keys(settings), Object.keys(fixture.theirs));
  const claims = await readdir(`${fixture.context.dataHome}/acc/adapter-antigravity`);
  assert.equal(claims.some(name => name.startsWith("allow-rule-")), true, claims.join(", "));
});
