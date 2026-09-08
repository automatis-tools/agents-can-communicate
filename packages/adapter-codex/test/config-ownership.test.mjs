import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAdapter } from "../src/adapter.mjs";
import { rewrittenCodexConfig, clientTables } from "../../../tests/helpers/codex-config.mjs";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-config-ownership-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const context = { home, stateRoot: path.join(home, "data", "acc") };
  const file = path.join(home, ".codex", "config.toml");
  await mkdir(path.dirname(file), { recursive: true });
  return { context, file, adapter: createCodexAdapter() };
}

for (const operation of ["install", "uninstall"]) {
  test(`${operation} preserves native tables relocated inside legacy comments`, async t => {
    const { context, file, adapter } = await fixture(t);
    await writeFile(file, rewrittenCodexConfig(context.stateRoot));
    const result = await adapter[operation](context);
    assert.ok(result.diagnostics.some(line => line.includes("sandbox") && line.includes("preserved")),
      "preserved sandbox settings were not reported");
    const after = await readFile(file, "utf8");
    assert.ok(after.includes(clientTables), "client trust/preferences were consumed by ACC markers");
    assert.ok(after.includes(`writable_roots = [${JSON.stringify(context.stateRoot)}]`),
      "legacy sandbox ownership is uncertain; preserve its effective value");
    assert.equal((after.match(/\[sandbox_workspace_write\]/g) ?? []).length, 1);
    assert.equal((after.match(/\[marketplaces.acc-local\]/g) ?? []).length,
      operation === "install" ? 1 : 0);
  });
}

test("modified new sandbox keeps added keys and changed roots through refresh and removal", async t => {
  for (const edit of [
    text => text.replace("[sandbox_workspace_write]", "[sandbox_workspace_write]\nnetwork_access = true"),
    text => text.replace(`writable_roots = [`, `writable_roots = ["/user-root", `),
  ]) {
    const { context, file, adapter } = await fixture(t);
    await adapter.install(context);
    const modified = edit(await readFile(file, "utf8"));
    await writeFile(file, modified);
    await adapter.install(context);
    await adapter.uninstall(context);
    const after = await readFile(file, "utf8");
    assert.ok(after.includes(`"${context.stateRoot}"`), "modified sandbox roots were erased");
    if (modified.includes("network_access")) assert.match(after, /network_access = true/);
    else assert.match(after, /"\/user-root"/);
    assert.equal((after.match(/\[sandbox_workspace_write\]/g) ?? []).length, 1);
  }
});

test("unterminated multiline TOML refuses without touching client files", async t => {
  const { context, file, adapter } = await fixture(t);
  const source = rewrittenCodexConfig(context.stateRoot).replace("[sandbox_workspace_write]",
    '[sandbox_workspace_write]\nnote = """\n[marketplaces.acc-local]');
  await writeFile(file, source);
  for (const operation of ["install", "uninstall"]) {
    await assert.rejects(adapter[operation](context), /ambiguous.*TOML|TOML.*ambiguous/i);
    assert.equal(await readFile(file, "utf8"), source);
    await assert.rejects(readFile(path.join(context.home, ".agents", "acc-local",
      ".agents", "plugins", "marketplace.json")), { code: "ENOENT" });
  }
});

test("multiline values and quoted headers preserve table-like and marker-like content", async t => {
  const { context, file, adapter } = await fixture(t);
  const literal = `[projects."/synthetic/project"]
notes = """
[marketplaces.acc-local]
# <<< agents-can-communicate
"""
roots = [
  "/one",
  "/two",
]
`;
  const source = rewrittenCodexConfig(context.stateRoot)
    .replace("[marketplaces.acc-local]", '[ "marketplaces" . \'acc-local\' ] # native formatting')
    .replace(clientTables, literal + clientTables.replace('[projects."/synthetic/project"]',
      '[projects."/other/project"]'));
  await writeFile(file, source);
  await adapter.install(context);
  await adapter.uninstall(context);
  const after = await readFile(file, "utf8");
  assert.ok(after.includes(literal), "TOML string contents were mistaken for ownership boundaries");
  assert.doesNotMatch(after, /source_type = "local"/);
});

test("metadata moved to another table does not authorize sandbox deletion", async t => {
  const { context, file, adapter } = await fixture(t);
  await adapter.install(context);
  const initial = await readFile(file, "utf8");
  const metadata = initial.split("\n").find(line => line.startsWith("# ACC sandbox"));
  assert.ok(metadata, "fresh sandbox creation did not record value ownership");
  const moved = initial.replace(`${metadata}\n`, "")
    .replace("# <<< agents-can-communicate", `[projects."/synthetic/project"]\n${metadata}\ntrust_level = "trusted"\n# <<< agents-can-communicate`);
  await writeFile(file, moved);
  await adapter.uninstall(context);
  const after = await readFile(file, "utf8");
  assert.ok(after.includes(`"${context.stateRoot}"`));
  assert.match(after, /trust_level = "trusted"/);
});

test("a multiline root string cannot hide the need for ACC's sandbox table", async t => {
  const { context, file, adapter } = await fixture(t);
  const original = 'note = """\nsandbox_workspace_write = {}\n"""\n';
  await writeFile(file, original);
  await adapter.install(context);
  const after = await readFile(file, "utf8");
  assert.match(after, /\[sandbox_workspace_write\]/);
  assert.ok(after.includes(`"${context.stateRoot}"`));
  await adapter.uninstall(context);
  assert.equal(await readFile(file, "utf8"), original);
});

test("unknown ACC registration keys refuse before modifying any client files", async t => {
  const { context, file, adapter } = await fixture(t);
  const original = rewrittenCodexConfig(context.stateRoot).replace('enabled = true',
    'enabled = true\nunknown_option = "preserve"');
  await writeFile(file, original);
  for (const operation of ["install", "uninstall"]) {
    await assert.rejects(adapter[operation](context), /ambiguous.*TOML/i);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("equivalent user registration declarations cannot be duplicated", async t => {
  for (const original of [
    'marketplaces.acc-local = { source_type = "local", source = "/user" }\n',
    '[marketplaces]\nacc-local = { source_type = "local", source = "/user" }\n',
    '[plugins]\n"agents-can-communicate@acc-local" = { enabled = false }\n',
  ]) {
    const { context, file, adapter } = await fixture(t);
    await writeFile(file, original);
    await assert.rejects(adapter.install(context), /already registered/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("quoted sandbox headers and inline root keys reserve a single sandbox", async t => {
  for (const original of [
    '[ "sandbox_workspace_write" ] # user\nwritable_roots = ["/user"]\n',
    '"sandbox_workspace_write" = { writable_roots = ["/user"] }\n',
  ]) {
    const { context, file, adapter } = await fixture(t);
    await writeFile(file, original);
    await adapter.install(context);
    assert.equal(((await readFile(file, "utf8")).match(/writable_roots/g) ?? []).length, 1,
      "install introduced a duplicate sandbox declaration");
    await adapter.uninstall(context);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

for (const quote of ['"', "'"]) {
  for (const count of [3, 4, 5]) {
    test(`multiline ${quote} closing run of ${count} preserves foreign values`, async t => {
      const { context, file, adapter } = await fixture(t);
      const original = `developer_instructions = ${quote.repeat(3)}line one\nline two${quote.repeat(count)}\n`;
      await writeFile(file, original);
      await adapter.install(context);
      await adapter.install(context);
      assert.ok((await readFile(file, "utf8")).startsWith(original));
      await adapter.uninstall(context);
      assert.equal(await readFile(file, "utf8"), original);
    });
  }
}

test("TOML eight-digit Unicode escapes preserve foreign keys and identify owned registration", async t => {
  const { context, file, adapter } = await fixture(t);
  const original = '[projects."\\U0001F600"]\ntrust_level = "trusted"\n';
  await writeFile(file, original);
  await adapter.install(context);
  const installed = (await readFile(file, "utf8"))
    .replace('[marketplaces.acc-local]', '["\\U0000006Darketplaces"."\\U00000061cc-local"]');
  await writeFile(file, installed);
  await adapter.install(context);
  assert.ok((await readFile(file, "utf8")).startsWith(original));
  await adapter.uninstall(context);
  assert.equal(await readFile(file, "utf8"), original);

  const userRegistration = '[marketplaces."\\U00000061cc-local"]\nsource = "/user"\n';
  await writeFile(file, userRegistration);
  await assert.rejects(adapter.install(context), /already registered/);
  assert.equal(await readFile(file, "utf8"), userRegistration);
});
