import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ALL_ADAPTERS, clientContext } from "@agents-can-communicate/cli";

/**
 * Every client's home, put back exactly as it was found.
 *
 * The installer edits configuration for four other tools. Two of them were held
 * to this - Kimi by `installer.test.mjs`, Claude Code after it was caught
 * leaving a one-byte difference in a file it had only borrowed - and the other
 * two were not held to it at all.
 *
 * The user's settings are the asset here. A tool that edits them has to be able
 * to prove it can put them back, for every client it touches and not only the
 * ones someone happened to write a test for.
 */
const digest = async file => createHash("sha256").update(await readFile(file)).digest("hex");

/** Every file under a directory, with its digest. Missing directory reads empty. */
async function fingerprint(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
    .catch(() => []);
  const files = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    files.set(path.relative(root, file), await digest(file));
  }
  return files;
}

/**
 * A home that already looks lived in.
 *
 * An empty home proves the weakest version of this: everything ACC wrote can be
 * deleted outright and the result is still "as found". These are the files
 * uninstall has to leave alone while removing its own from beside them.
 */
async function livedIn(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-restore-")));
  t.after(() => rm(home, { recursive: true, force: true }));

  const write = async (relative, content) => {
    const file = path.join(home, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await write(".codex/config.toml",
    'model = "o3"\n\n[model_providers.mine]\nname = "mine"\n');
  // Written the way these clients write their own files - two-space JSON - so
  // that "as found" is a standard about the files a user will actually have.
  // ACC re-emits what it edits, so a hand-compacted object comes back expanded:
  // every value survives and the whitespace does not. Recorded as a limitation
  // rather than asserted here, where it would only be testing the fixture.
  const clientJson = value => JSON.stringify(value, null, 2);
  await write(".agents/plugins/marketplace.json",
    clientJson({ plugins: [{ name: "their-plugin", source: "./x" }] }));
  await write(".gemini/settings.json",
    clientJson({ theme: "Dracula", extensions: { "their-extension": true } }));
  await write(".gemini/extensions/their-extension/gemini-extension.json",
    clientJson({ name: "x" }));
  await write(".claude/settings.json",
    clientJson({ enabledPlugins: { "their-plugin@their-market": true } }));
  await write(".kimi-code/config.toml", 'default_model = "k3"\n');
  return home;
}

for (const adapterId of ["codex", "claude_code", "gemini_cli", "kimi"]) {
  test(`${adapterId}: install then uninstall leaves the home as it was found`, async t => {
    const home = await livedIn(t);
    const adapter = ALL_ADAPTERS().find(item => item.id === adapterId);
    const before = await fingerprint(home);

    await adapter.install(clientContext(home));
    const during = await fingerprint(home);
    assert.notDeepEqual([...during.keys()].sort(), [...before.keys()].sort(),
      "the install wrote nothing, so this proves nothing about removing it");

    await adapter.uninstall(clientContext(home));
    const after = await fingerprint(home);

    const changed = [...before]
      .filter(([file, hash]) => after.get(file) !== hash)
      .map(([file]) => file);
    const left = [...after.keys()].filter(file => !before.has(file));
    assert.deepEqual(changed, [], `${adapterId} did not restore: ${changed.join(", ")}`);
    assert.deepEqual(left, [], `${adapterId} left files behind: ${left.join(", ")}`);
  });

  test(`${adapterId}: installing twice is the same as installing once`, async t => {
    const home = await livedIn(t);
    const adapter = ALL_ADAPTERS().find(item => item.id === adapterId);

    await adapter.install(clientContext(home));
    const once = await fingerprint(home);
    await adapter.install(clientContext(home));
    const twice = await fingerprint(home);

    // A second install that appends rather than replaces is how a client ends
    // up registering the same hook twice and firing it twice per event - which
    // Gemini did, and which showed up as `2 succeeded, 1 failed` on every event.
    const differing = [...twice].filter(([file, hash]) => once.get(file) !== hash)
      .map(([file]) => file);
    assert.deepEqual(differing, [],
      `${adapterId} writes something different the second time: ${differing.join(", ")}`);
  });
}

/**
 * The style is read from the file, so every style a file can be in has to
 * survive being read and written back. Counting the indent characters instead
 * of keeping them turned one tab into one space and reformatted every line of a
 * file this exists to leave alone.
 */
test("a foreign file keeps its own formatting, whatever that is", async t => {
  const { formatJsonAs, jsonStyleOf } = await import("@agents-can-communicate/adapter-sdk");
  const shapes = {
    "tab indented": "{\n\t\"a\": 1\n}",
    "two spaces": "{\n  \"a\": 1\n}",
    "four spaces, trailing newline": "{\n    \"a\": 1\n}\n",
    "all on one line": "{\"a\":1}",
    "one line, trailing newline": "{\"a\":1}\n",
    "empty": "{}",
  };

  for (const [label, text] of Object.entries(shapes)) {
    const written = formatJsonAs(JSON.parse(text), jsonStyleOf(text));
    assert.equal(written, text, `${label} came back as ${JSON.stringify(written)}`);
  }
  assert.equal(t.name.length > 0, true);
});

test("a file ACC creates gets the conventional shape", async () => {
  const { formatJsonAs, jsonStyleOf } = await import("@agents-can-communicate/adapter-sdk");

  // No file, no style to preserve. Two spaces and a trailing newline is what
  // everything else in this repository writes.
  assert.equal(formatJsonAs({ a: 1 }, jsonStyleOf(null)), '{\n  "a": 1\n}\n');
});
