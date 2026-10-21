import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = path.resolve(import.meta.dirname, "../website/public/assets/site.mjs");

test("wide tables explain sideways scrolling and hide the hint when they fit", async () => {
  let hint, resize;
  const table = { clientWidth: 300, scrollWidth: 650, before(element) { hint = element; } };
  const document = { addEventListener() {}, querySelector: () => null,
    querySelectorAll: selector => selector === ".table-scroll" ? [table] : [],
    createElement: () => ({ hidden: false, className: "", textContent: "" }) };
  class ResizeObserver { constructor(callback) { resize = callback; } observe() {} }
  runInNewContext(await readFile(script, "utf8"), { document, ResizeObserver });
  assert.ok(hint, "overflowing tables need a visible explanation");
  assert.match(hint.textContent, /scroll.*sideways/i);
  assert.equal(hint.hidden, false);
  table.clientWidth = 700;
  resize();
  assert.equal(hint.hidden, true, "fitting tables must not invite unnecessary scrolling");
});

import { siteArtifact } from "./website-helpers.mjs";
import { loadContent } from "../website/lib/content.mjs";
import { renderedPages, validateBuiltSite } from "../website/lib/build-contracts.mjs";

test("the homepage includes the real captured question and answer before replay runs", async () => {
  const directory = await siteArtifact();
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const record = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../website/src/data/recording.json"), "utf8"));
  assert.ok(html.includes('id="recorded-exchange"'), "the real recording must be present in initial HTML");
  for (const message of record.messages) assert.ok(html.includes(message.text), "captured message must be readable without playback");
  for (const client of record.clients) assert.ok(html.includes(client.name + " " + client.version));
  assert.ok(html.includes(record.delivery));
});

test("a recording cannot publish native owner credentials in the static artifact", async t => {
  const directory = await siteArtifact();
  const file = path.join(directory, "assets/demo/exchange.json");
  const original = await readFile(file, "utf8");
  const articles = await loadContent(path.resolve(import.meta.dirname, "../website/content"));
  const expectedRoutes = [...(await renderedPages(directory)).keys()];
  for (const [name, mutate] of [
    ["credential in message text", record => { record.note += " generation_do_not_publish_this_credential"; }],
    ["native owner context", record => { record.owner = { sessionId: "opaque-native-id", generation: "opaque-native-credential" }; }],
    ["native context nested in a note", record => { record.note = { owner: { sessionId: "opaque-native-id", generation: "opaque-native-credential" } }; }],
    ["native context nested in a label", record => { record.messages[0].label = { owner: { sessionId: "opaque-native-id", generation: "opaque-native-credential" } }; }],
    ["native context nested in an optional relation", record => { record.messages[0].inReplyTo = { owner: { sessionId: "opaque-native-id" } }; }],
    ["non-scalar artifact name", record => { record.source.artifacts[0].name = [record.source.artifacts[0].name]; }],
  ]) {
    await t.test(name, async () => {
      try {
        const record = JSON.parse(original); mutate(record);
        await writeFile(file, JSON.stringify(record));
        await assert.rejects(validateBuiltSite({ outDir: directory, articles, expectedRoutes }), /recording.*(privacy|credential|data)/i);
      } finally { await writeFile(file, original); }
    });
  }
});


test("a replay starts with captured messages and can restore them without delayed updates", async () => {
  const outputs = [{ dataset: { recordingClient: "codex" }, textContent: "Actual question?", style: {}, getBoundingClientRect: () => ({height:42}) },
    { dataset: { recordingClient: "antigravity" }, textContent: "Actual answer.", style: {}, getBoundingClientRect: () => ({height:42}) }];
  const steps = [{ dataset: { recordingAt: "0", recordingClient: "codex", recordingKind: "recorded", recordingLabel: "Question recorded" }, textContent: "Question recorded", toggleAttribute() {} },
    { dataset: { recordingAt: "1000", recordingClient: "antigravity", recordingKind: "recorded", recordingLabel: "Reply recorded" }, textContent: "Reply recorded", toggleAttribute() {} }];
  let click;
  const button = { hidden: true, textContent: "Replay exchange", addEventListener: (_, listener) => { click = listener; } };
  const status = { textContent: "Full recorded exchange." };
  const recording = { querySelector: selector => selector === "[data-recording-replay]" ? button : status,
    querySelectorAll: selector => selector === "[data-recording-output]" ? outputs : steps };
  const document = { addEventListener() {}, querySelector: selector => selector === "[data-recorded-exchange]" ? recording : null, querySelectorAll: () => [] };
  const timers = new Map(); let next = 0;
  runInNewContext(await readFile(script, "utf8"), { document, window: { matchMedia: () => ({ matches: false }) },
    setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id) });
  assert.equal(button.hidden, false, "replay control must become usable");
  click();
  const first = timers.entries().next().value; timers.delete(first[0]); first[1]();
  assert.equal(outputs[0].textContent, "Actual question?");
  assert.equal(outputs[1].textContent, "");
  click();
  assert.deepEqual(outputs.map(output => output.textContent), ["Actual question?", "Actual answer."]);
  const stoppedStatus = status.textContent;
  for (const callback of timers.values()) callback();
  assert.equal(status.textContent, stoppedStatus, "stopped replay must not keep announcing stale events");
});
