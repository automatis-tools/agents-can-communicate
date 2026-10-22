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
  const readable = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  for (const message of record.messages) assert.ok(readable.includes(message.text), "captured message must be readable without playback");
  for (const client of record.clients) assert.ok(html.includes(client.name.replace(" CLI", "")));
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


function exchangeFixture(reduced = false, examples = null, random = () => 0) {
  const timers = new Map(), listeners = new Map(), steps = [], media = { matches: reduced, addEventListener: (type, fn) => listeners.set("motion", fn) };
  const button = { hidden: true, textContent: "Play again", addEventListener: (_, fn) => listeners.set("play", fn) };
  const status = { textContent: "Answer received." }, controls = { hidden: true };
  for (const phase of ["question", "reply", "complete"]) steps.push({ dataset: { exchangeStep: phase },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    addEventListener(_, fn) { listeners.set(phase, fn); } });
  const fields = Object.fromEntries(["title", "from", "fromRole", "fromIntent", "to", "toRole", "toIntent", "question", "answer", "contextKey", "contextValue", "evidence", "guide", "questionLabel", "answerLabel", "fromShell", "toShell", "fromPrompt", "toPrompt", "fromCommand", "toCommand", "fromGlyph", "toGlyph", "fromWriting", "toWriting", "fromAuthor", "toAuthor", "outboundCommand", "returnCommand", "outcome", "stepOne", "stepTwo", "stepThree"].map(key => [key, { textContent: "", href: "", style: {}, getBoundingClientRect: () => ({ height: 48 }) }]));
  fields.question.textContent = "Actual question?"; fields.answer.textContent = "Actual answer.";
  const terminals = { from: { dataset: {} }, to: { dataset: {} } };
  const next = { hidden: true, addEventListener: (_, fn) => listeners.set("next", fn) };
  const recording = { style: { setProperty(name, value) { this[name] = value; } }, dataset: { phase: "complete" }, setAttribute(name, value) { this[name] = value; },
    querySelector: selector => selector === "[data-exchange-play]" ? button : selector === "[data-exchange-controls]" ? controls
      : selector === "[data-exchange-status]" ? status : selector === "[data-exchange-scenarios]" ? (examples ? { textContent: JSON.stringify(examples) } : null)
      : selector === "[data-exchange-next]" ? next : selector.includes("data-exchange-terminal=") ? terminals[selector.match(/data-exchange-terminal="(.+?)"/)?.[1]] : fields[selector.match(/data-exchange-field="(.+?)"/)?.[1]] ?? null,
    querySelectorAll: selector => selector === "[data-exchange-step]" ? steps : [] };
  const document = { hidden: false, addEventListener: (type, fn) => listeners.set(type, fn),
    querySelector: selector => selector === "[data-recorded-exchange]" ? recording : null, querySelectorAll: () => [] };
  let observe, clock = 0, sequence = 0;
  class IntersectionObserver { constructor(fn) { observe = fn; } observe() {} unobserve() {} }
  return { recording, button, controls, status, steps, timers, document, media, fields, terminals,
    context: { document, IntersectionObserver, Math: { random, max: Math.max, min: Math.min, floor: Math.floor }, performance: { now: () => clock }, window: { matchMedia: () => media },
      setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id) },
    visible: value => observe?.([{ isIntersecting: value, intersectionRatio: value ? 1 : 0 }]),
    click: name => { assert.equal(typeof listeners.get(name), "function", name + " control must be wired"); listeners.get(name)(); },
    runTo(check) { for (let attempt = 0; !check(); attempt++) {
      assert.ok(attempt < 10000, "animation must reach its next observable state");
      const next = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
      assert.ok(next, "the running story needs a scheduled update"); this.runUntil(next[1].at);
    } },
    runToPhase(value) { this.runTo(() => recording.dataset.phase === value); },
    nextStory() { const prior = recording.dataset.example; this.runTo(() => recording.dataset.example !== prior); },
    runUntil(at) { for (;;) { const next = [...timers].sort((a,b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > at) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn(); } clock = at; },
  };
}

test("each terminal streams its text before the completion highlight and command flight", async () => {
  const fixture = exchangeFixture();
  runInNewContext(await readFile(script, "utf8"), fixture.context); fixture.visible(true);
  assert.equal(fixture.recording.dataset.phase, "question-focus"); assert.equal(fixture.fields.question.textContent, "");
  fixture.runUntil(1200);
  assert.equal(fixture.recording.dataset.phase, "question-type");
  const prefix = fixture.fields.question.textContent;
  assert.ok(prefix.length > 0 && prefix.length < "Actual question?".length);
  assert.ok("Actual question?".startsWith(prefix)); assert.equal(fixture.fields.answer.textContent, "");
  fixture.runUntil(3600); assert.equal(fixture.recording.dataset.phase, "question-type");
  fixture.runUntil(3800); assert.equal(fixture.recording.dataset.phase, "question-done");
  assert.equal(fixture.fields.question.textContent, "Actual question?");
  fixture.runUntil(4400); assert.equal(fixture.recording.dataset.phase, "question-send");
  fixture.runUntil(6200); assert.equal(fixture.recording.dataset.phase, "reply-focus");
  fixture.runUntil(7600); assert.equal(fixture.recording.dataset.phase, "reply-type");
  assert.ok(fixture.fields.answer.textContent.length > 0 && fixture.fields.answer.textContent.length < "Actual answer.".length);
  fixture.runUntil(9900); assert.equal(fixture.recording.dataset.phase, "reply-done");
  assert.equal(fixture.fields.answer.textContent, "Actual answer.");
  fixture.runUntil(10500); assert.equal(fixture.recording.dataset.phase, "reply-send");
  fixture.runUntil(12500); assert.equal(fixture.recording.dataset.phase, "complete");
  fixture.runUntil(15300); assert.equal(fixture.recording.dataset.phase, "question-focus");
});

test("manual steps and pausing cancel queued animation updates", async () => {
  const fixture = exchangeFixture();
  runInNewContext(await readFile(script, "utf8"), fixture.context);
  fixture.click("play");
  assert.equal(fixture.recording.dataset.phase, "question-focus");
  fixture.click("reply");
  assert.equal(fixture.recording.dataset.phase, "reply-focus");
  assert.equal(fixture.steps[1]["aria-current"], "step");
  fixture.runUntil(8000);
  assert.equal(fixture.recording.dataset.phase, "reply-focus", "a manual selection must not be overwritten by stale playback");
  fixture.click("play"); fixture.click("play");
  const paused = fixture.recording.dataset.phase;
  fixture.runUntil(30000);
  assert.equal(fixture.recording.dataset.phase, paused);
  assert.equal(fixture.timers.size, 0);
});

test("reduced-motion readers get the full answer without autoplay", async () => {
  const fixture = exchangeFixture(true);
  runInNewContext(await readFile(script, "utf8"), fixture.context);
  fixture.visible(true);
  assert.equal(fixture.recording.dataset.phase, "complete");
  assert.equal(fixture.timers.size, 0);
  fixture.click("reply");
  assert.equal(fixture.recording.dataset.phase, "reply-focus", "manual steps still work without motion");
});

test("pausing during streamed text preserves its prefix and explicit pause survives returning", async () => {
  const fixture = exchangeFixture();
  runInNewContext(await readFile(script, "utf8"), fixture.context);
  fixture.visible(true); fixture.runUntil(1200); fixture.visible(false);
  const prefix = fixture.fields.question.textContent;
  assert.equal(fixture.timers.size, 0);
  fixture.runUntil(15000); assert.equal(fixture.fields.question.textContent, prefix);
  fixture.visible(true); fixture.runUntil(16000);
  assert.equal(fixture.recording.dataset.phase, "question-type");
  assert.ok(fixture.fields.question.textContent.length > prefix.length);
  fixture.click("play"); const paused = fixture.fields.question.textContent;
  fixture.visible(false); fixture.visible(true); fixture.runUntil(35000);
  assert.equal(fixture.fields.question.textContent, paused); assert.equal(fixture.timers.size, 0);
});

test("every page-load draw renders one coherent example from all ten scenarios", async () => {
  const directory = await siteArtifact();
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const embedded = html.match(/<script[^>]*data-exchange-scenarios[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(embedded, "the static artifact must supply the curated scenario collection");
  const examples = JSON.parse(embedded[1]);
  assert.equal(examples.length, 10);
  assert.equal(new Set(examples.map(item => item.id)).size, 10);
  const seen = new Set();
  const commands = { "Codex": "codex", "Claude Code": "claude", "Antigravity": "agy", "Kimi Code": "kimi", "Grok Build": "grok", "Gemini CLI": "gemini" };
  for (let index = 0; index < 10; index++) {
    const fixture = exchangeFixture(false, examples, () => (index + .5) / 10);
    runInNewContext(await readFile(script, "utf8"), fixture.context);
    for (const key of ["from", "to", "question", "answer", "contextKey", "contextValue"]) {
      assert.equal(fixture.fields[key].textContent, examples[index][key], key + " must belong to the selected example");
    }
    assert.equal(fixture.fields.guide.href, examples[index].guide);
    assert.notEqual(fixture.terminals.from.dataset.platform, fixture.terminals.to.dataset.platform);
    assert.notEqual(fixture.terminals.from.dataset.palette, fixture.terminals.to.dataset.palette);
    for (const side of ["from", "to"]) {
      assert.equal(fixture.fields[side + "Command"].textContent, commands[examples[index][side]]);
      const author = examples[index][side].replace(/ (Code|CLI|Build)$/, "");
      assert.equal(fixture.fields[side + "Writing"].textContent, author + " writing…");
      assert.equal(fixture.fields[side + "Author"].textContent, author);
    }
    seen.add(fixture.recording.dataset.example);
    fixture.visible(true); fixture.runToPhase("complete");
    assert.equal(fixture.fields.answer.textContent, examples[index].answer, "one story must keep its selected conversation until it finishes");
  }
  assert.equal(seen.size, 10, "every example must be reachable by a page-load draw");
});

test("another-example control changes the conversation even when random repeats", async () => {
  const directory = await siteArtifact();
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const embedded = html.match(/<script[^>]*data-exchange-scenarios[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(embedded, "scenario data must reach the built page");
  const examples = JSON.parse(embedded[1]);
  const fixture = exchangeFixture(false, examples, () => 0);
  runInNewContext(await readFile(script, "utf8"), fixture.context);
  const first = fixture.recording.dataset.example;
  fixture.click("next");
  assert.notEqual(fixture.recording.dataset.example, first);
  const selected = examples.find(example => example.id === fixture.recording.dataset.example);
  fixture.runToPhase("complete");
  assert.equal(fixture.fields.question.textContent, selected.question);
  assert.equal(fixture.fields.answer.textContent, selected.answer);
  assert.match(fixture.fields.evidence.textContent, /workflow example/i);
});

test("the capture must remain readable outside its JSON data", async () => {
  const directory = await siteArtifact(), file = path.join(directory, "index.html");
  const original = await readFile(file, "utf8");
  const articles = await loadContent(path.resolve(import.meta.dirname, "../website/content"));
  const expectedRoutes = [...(await renderedPages(directory)).keys()];
  const changed = original.replace(/(<p[^>]*data-exchange-field="answer"[^>]*>)[\s\S]*?(<\/p>)/, "$1$2");
  assert.notEqual(changed, original, "the mutation must remove actual visible answer text");
  try {
    await writeFile(file, changed);
    await assert.rejects(validateBuiltSite({ outDir: directory, articles, expectedRoutes }), /recording content contract/);
  } finally { await writeFile(file, original); }
});

test("the showcase covers claims, releases, intent and handoffs with actual ACC command names", async () => {
  const html = await readFile(path.join(await siteArtifact(), "index.html"), "utf8");
  const examples = JSON.parse(html.match(/<script[^>]*data-exchange-scenarios[^>]*>([\s\S]*?)<\/script>/)[1]);
  const kinds = new Set(examples.map(example => example.kind));
  for (const kind of ["claim", "release", "intent", "handoff", "decision", "review", "question"]) assert.ok(kinds.has(kind), kind + " must be represented");
  const commands = new Set(["acc message", "acc reply", "acc claim", "acc release", "acc work", "acc finish", "acc ack", "acc request"]);
  for (let index = 0; index < examples.length; index++) {
    const example = examples[index];
    assert.ok(commands.has(example.outboundCommand)); assert.ok(commands.has(example.returnCommand));
    const fixture = exchangeFixture(false, examples, () => (index + .5) / 10);
    runInNewContext(await readFile(script, "utf8"), fixture.context);
    assert.equal(fixture.fields.outboundCommand.textContent, example.outboundCommand);
    assert.equal(fixture.fields.returnCommand.textContent, example.returnCommand);
    assert.equal(fixture.fields.outcome.textContent, example.outcome);
  }
});

test("autoplay shows all ten shuffled stories before repeating and changes terminal skins", async () => {
  const html = await readFile(path.join(await siteArtifact(), "index.html"), "utf8");
  const examples = JSON.parse(html.match(/<script[^>]*data-exchange-scenarios[^>]*>([\s\S]*?)<\/script>/)[1]);
  const fixture = exchangeFixture(false, examples, () => 0);
  runInNewContext(await readFile(script, "utf8"), fixture.context);
  fixture.visible(true);
  const seen = []; let priorSkin;
  for (let turn = 0; turn < 10; turn++) {
    if (turn) fixture.nextStory();
    fixture.runToPhase("complete");
    seen.push(fixture.recording.dataset.example);
    const skin = [fixture.terminals.from.dataset.platform, fixture.terminals.to.dataset.platform, fixture.terminals.from.dataset.palette, fixture.terminals.to.dataset.palette];
    if (priorSkin) for (let side = 0; side < skin.length; side++) assert.notEqual(skin[side], priorSkin[side], "each terminal gets a new skin between stories");
    priorSkin = skin;
    const selected = examples.find(example => example.id === seen.at(-1));
    assert.equal(fixture.fields.outboundCommand.textContent, selected.outboundCommand);
    assert.equal(fixture.fields.answer.textContent, selected.answer);
  }
  assert.equal(new Set(seen).size, 10, "random must not strand the viewer on a repeated subset");
  fixture.nextStory();
  assert.notEqual(fixture.recording.dataset.example, seen.at(-1), "a reshuffle must not repeat the last story immediately");
});

test("switching stories during typing cannot leave writes from the old message", async () => {
  const html = await readFile(path.join(await siteArtifact(), "index.html"), "utf8");
  const examples = JSON.parse(html.match(/<script[^>]*data-exchange-scenarios[^>]*>([\s\S]*?)<\/script>/)[1]);
  const fixture = exchangeFixture(false, examples, () => 0);
  runInNewContext(await readFile(script, "utf8"), fixture.context);
  fixture.visible(true); fixture.runUntil(1500); fixture.click("next");
  const current = examples.find(example => example.id === fixture.recording.dataset.example);
  fixture.runToPhase("complete"); fixture.click("complete"); fixture.runUntil(100000);
  assert.equal(fixture.fields.question.textContent, current.question);
  assert.equal(fixture.fields.answer.textContent, current.answer); assert.equal(fixture.timers.size, 0);
});
