import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BEGIN, END } from "@agents-can-communicate/adapter-sdk";
import { installCodexPlugin, uninstallCodexPlugin } from "../src/install.mjs";

const FOREIGN = `# Written by Codex after interactive trust
[projects."/tmp/acc-project-c"]
trust_level = "trusted" # keep this decision

[hooks.state."agents-can-communicate@acc-local:hooks.json:session_start:0:0"]
trusted_hash = "sha256:client-owned"

[other.preferences]
choice = 'leave exactly as written'
`;

async function fixture(t, foreign = FOREIGN) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-codex-preserve-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const context = { home, stateRoot: path.join(home, "state") };
  await installCodexPlugin(context);
  const file = path.join(home, ".codex", "config.toml");
  const installed = await readFile(file, "utf8");
  await writeFile(file, `model = "example"\n${installed.replace(END, foreign + END)}`);
  return { context, file, read: () => readFile(file, "utf8") };
}

function assertPreserved(source, foreign = FOREIGN) {
  assert.ok(source.startsWith('model = "example"\n'), "outside config changed");
  assert.ok(source.includes(foreign), "client-owned TOML bytes were lost or rewritten");
}

for (const operation of ["reinstall", "uninstall"]) {
  test(`${operation} preserves client trust inserted before ACC END`, async t => {
    const { context, read } = await fixture(t);
    if (operation === "reinstall") {
      // Policy changes call this same installer; policy is kept outside config.toml.
      for (const delivery of ["all", "actionable", "actionable"]) {
        await installCodexPlugin({ ...context, delivery });
        assertPreserved(await read());
      }
      const once = await read();
      await installCodexPlugin(context);
      assert.equal(await read(), once, "equivalent reinstall changed config bytes");
      for (const header of ["[marketplaces.acc-local]",
        '[plugins."agents-can-communicate@acc-local"]', "[sandbox_workspace_write]"]) {
        assert.equal(once.split(header).length - 1, 1, "owned table duplicated");
      }
    }
    await uninstallCodexPlugin(context);
    const removed = await read();
    assertPreserved(removed);
    assert.ok(!removed.includes(BEGIN));
    assert.ok(!removed.includes("[sandbox_workspace_write]"));
    assert.ok(!removed.includes("[marketplaces.acc-local]"));
    assert.ok(!removed.includes('[plugins."agents-can-communicate@acc-local"]'));
    await uninstallCodexPlugin(context);
    assert.equal(await read(), removed, "repeat uninstall changed foreign bytes");
  });
}

const ADVERSARIAL = `# foreign headers and marker text remain values
["projects" . '/tmp/path.with.dots#and]brackets'] # header comment
trust_level = 'trusted'
note = """
[marketplaces.acc-local]
${BEGIN}
${END}
"""
literal = '''
[plugins."agents-can-communicate@acc-local"]
${END}
'''
items = [
  "[sandbox_workspace_write]", # not a table
  "${END}",
]
["hooks" . 'state' . "plugin.with.dots"]
trusted_hash = "escaped \\\" quote"
[["other" . 'entries']]
name = 'first'
[[other.entries]] # another array entry
name = 'second'
`;

test("quoted, array and multiline foreign content survives repeated install/remove", async t => {
  const { context, read } = await fixture(t, ADVERSARIAL);
  await installCodexPlugin(context);
  assertPreserved(await read(), ADVERSARIAL);
  const installed = await read();
  await installCodexPlugin(context);
  assert.equal(await read(), installed);
  await uninstallCodexPlugin(context);
  assertPreserved(await read(), ADVERSARIAL);
});

for (const declaration of [
  '["sandbox_workspace_write"]\nwritable_roots = ["/tmp/theirs"]\n',
  "['sandbox_workspace_write'.nested]\nx = 1\n",
  '"sandbox_workspace_write".writable_roots = ["/tmp/theirs"]\n',
]) {
  test(`foreign sandbox declaration is preserved: ${declaration.split("\n")[0]}`, async t => {
    const { context, file, read } = await fixture(t);
    // A sandbox set outside the marked region always belongs to the user.
    await writeFile(file, declaration + await read());
    await installCodexPlugin(context);
    assert.ok((await read()).startsWith(declaration));
    assert.ok(!(await read()).includes("[sandbox_workspace_write]"));
    await uninstallCodexPlugin(context);
    assert.ok((await read()).startsWith(declaration));
  });
}

for (const [reason, damaged] of [
  ["missing END", source => source.replace(END, "")],
  ["nested BEGIN", source => source.replace(END, BEGIN + "\n" + END)],
  ["malformed header", source => source.replace(END, '[unknown."unterminated]\nx = 1\n' + END)],
  ["unclosed string", source => source.replace(END, '[other]\nnote = """\n' + END)],
  ["unknown owned key", source => source.replace('enabled = true', 'enabled = true\nforeign_setting = "keep"')],
  ["owned array table", source => source.replace('[marketplaces.acc-local]', '[[marketplaces.acc-local]]')],
]) {
  test(`${reason} refuses install/remove without changing config or plugin`, async t => {
    const { context, file, read } = await fixture(t);
    const before = damaged(await read());
    await writeFile(file, before);
    const plugin = path.join(context.home, ".agents", "acc-local", "plugins",
      "agents-can-communicate", "hooks.json");
    const sentinel = '{ "sentinel": "must not rewrite installed files on refusal" }\n';
    await writeFile(plugin, sentinel);
    for (const operation of [installCodexPlugin, uninstallCodexPlugin]) {
      await assert.rejects(operation(context), /cannot safely edit Codex config/);
      assert.equal(await read(), before, "refusal changed config bytes");
      assert.equal(await readFile(plugin, "utf8"), sentinel);
    }
  });
}

test("quoted foreign ACC registration conflicts before any installation rewrite", async t => {
  const { context, file, read } = await fixture(t);
  const foreign = '["marketplaces" . "acc-local"]\nsource_type = "local"\n';
  const before = (await read()).replace(END, END + "\n" + foreign);
  await writeFile(file, before);
  await assert.rejects(installCodexPlugin(context), /already registered/);
  assert.equal(await read(), before);
});

test("foreign sections interleaved between owned tables survive with CRLF formatting", async t => {
  const { context, file, read } = await fixture(t, "");
  const foreign = FOREIGN.replaceAll("\n", "\r\n");
  const before = (await read()).replace('[plugins.', foreign + '[plugins.');
  await writeFile(file, before);
  await installCodexPlugin(context);
  assertPreserved(await read(), foreign);
  await uninstallCodexPlugin(context);
  assertPreserved(await read(), foreign);
});

test("equivalent quoted and escaped owned headers are updated and removed once", async t => {
  const { context, file, read } = await fixture(t);
  await writeFile(file, (await read())
    .replace('[marketplaces.acc-local]', '["marketplaces" . \'acc-local\']')
    .replace('[plugins.', '["plugins" . ')
    .replace('[sandbox_workspace_write]', '["sandbox_workspace_writ\\u0065"]'));
  await installCodexPlugin(context);
  const installed = await read();
  assertPreserved(installed);
  assert.equal(installed.split('[marketplaces.acc-local]').length - 1, 1);
  assert.equal(installed.split('[sandbox_workspace_write]').length - 1, 1);
  await uninstallCodexPlugin(context);
  assertPreserved(await read());
  assert.ok(!(await read()).includes('sandbox_workspace'));
});

for (const foreign of [
  'plugins = {}\n',
  'marketplaces = {}\n',
  'plugins = { "other@foreign" = { enabled = true } }\n',
  'marketplaces = { "acc-local" = { source_type = "local", source = "/tmp/theirs" } }\n',
  '"marketplaces" = {}\n',
]) {
  test(`closed registration parent refuses before writes: ${foreign.trim()}`, async t => {
    const { context, file, read } = await fixture(t);
    await writeFile(file, foreign);
    const plugin = path.join(context.home, ".agents", "acc-local", "plugins",
      "agents-can-communicate", "hooks.json");
    const sentinel = '{ "sentinel": "keep installed bytes on refusal" }\n';
    await writeFile(plugin, sentinel);
    await assert.rejects(installCodexPlugin(context), /already registered/);
    assert.equal(await read(), foreign, "refusal changed config bytes");
    assert.equal(await readFile(plugin, "utf8"), sentinel);
  });
}

for (const foreign of [
  '[plugins]\n[marketplaces]\n',
  'plugins."other@foreign".enabled = true\nmarketplaces.foreign.source_type = "local"\n',
  '["plugins"]\n"other@foreign" = { enabled = true }\n[marketplaces]\nforeign = {}\n',
]) {
  test(`extensible registration namespace survives install/remove: ${foreign.split("\n")[0]}`, async t => {
    const { context, file, read } = await fixture(t);
    await writeFile(file, foreign);
    await installCodexPlugin(context);
    const installed = await read();
    assert.ok(installed.startsWith(foreign));
    assert.ok(installed.includes('[marketplaces.acc-local]'));
    assert.ok(installed.includes('[plugins."agents-can-communicate@acc-local"]'));
    await installCodexPlugin(context);
    assert.equal(await read(), installed);
    await uninstallCodexPlugin(context);
    assert.equal(await read(), foreign);
  });
}

for (const [damage, reason] of [
  [source => source.replace('enabled = true', 'enabled = true\nextra = "private-value-123"'),
    /unknown key in owned table/],
  [source => source.replace(END, '[other]\nnote = """private-value-123\n' + END),
    /unclosed string/],
]) {
  test("ambiguity diagnostics identify config and structural reason without values", async t => {
    const { context, file, read } = await fixture(t);
    const before = damage(await read());
    await writeFile(file, before);
    for (const operation of [installCodexPlugin, uninstallCodexPlugin]) {
      await assert.rejects(operation(context), error => {
        assert.ok(error.message.includes(file), "diagnostic omitted config path");
        assert.match(error.message, reason);
        assert.ok(!JSON.stringify(error).includes("private-value-123"));
        assert.ok(!error.message.includes("private-value-123"));
        return true;
      });
      assert.equal(await read(), before);
    }
  });
}
