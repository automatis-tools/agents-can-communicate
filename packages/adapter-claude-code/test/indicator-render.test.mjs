import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installClaudePlugin } from "../src/install.mjs";

for (const [health, reception, symbol, color] of [
  ["ready", "automatic", "●", "#2c7a39"],
  ["ready", "turn", "●", "#2c7a39"],
  ["problem", "turn", "!", "warning"],
  ["starting", null, "…", "inactive"],
]) test(`${health}/${reception}: only the status glyph gets its non-dim color, without a background`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-dot-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installClaudePlugin({ configDir: root, clientVersion: "2.1.295", indicator: "on" });
  const file = path.join(root, "plugins", "marketplaces", "acc-local", "agents-can-communicate", "hooks", "indicator.mjs");
  const module = await import(pathToFileURL(file).href);
  const handlers = new Map();
  module.register((event, matcher, handler) => handlers.set(event,
    typeof matcher === "function" ? matcher : handler));
  const $ = { session: { id: async () => "render-fixture" },
    clock: { now: async () => 10000, every: () => {} },
    command: { register: async () => {} },
    process: { run: async () => ({ stdout: JSON.stringify({ health, reception,
      label: `ACC ${symbol}${!reception || reception === "automatic" ? "" : ` · ${reception}`}`,
      reasonCode: health === "problem" ? "handshake_failed" : null }) }) },
    ui: { log: async () => {}, invalidate: () => {}, resolve: () => ({
      Box: props => ({ type: "Box", ...props }), Text: props => ({ type: "Text", ...props }),
    }) } };
  await handlers.get("session.start")($, {}, async e => e);
  const event = { props: { modes: ["existing-mode"] } };
  const native = { type: "engine", ref: "existing-footer" };
  const tree = await handlers.get("ui.render")($, event, async passed => {
    assert.deepEqual(passed, event, "the native footer must keep its original props");
    return native;
  });
  assert.equal(tree.type, "Box");
  assert.deepEqual(tree.children[0], native);
  const texts = tree.children.filter(node => node.type === "Text");
  const colored = texts.filter(node => node.bold === true);
  assert.equal(colored.length, 1, "only one glyph carries the state color");
  assert.equal(colored[0].children.join(""), symbol);
  assert.equal(colored[0].color, color);
  assert.equal(colored[0].dimColor, false);
  assert.equal(colored[0].bold, true);
  assert.equal(texts.map(node => node.children.join("")).join(""),
    ` ACC ${symbol}${!reception || reception === "automatic" ? "" : ` · ${reception}`}`);
  for (const node of [tree, ...texts]) assert.equal(node.backgroundColor, undefined);
  for (const node of texts.filter(node => node !== colored[0])) {
    assert.notEqual(node.bold, true);
    assert.equal(node.color, "inactive");
  }
});
