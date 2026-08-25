import assert from "node:assert/strict";
import test from "node:test";

import { editJson, readJson } from "../src/json-text.mjs";

/**
 * Editing someone else's file.
 *
 * The style was already read back out of the file, which kept the indentation
 * and reformatted everything the style could not describe. What a person writes
 * is not only an indent: a nested object kept on one line, a blank line between
 * sections, a space after a brace. None of it is ACC's to normalise.
 */
const settings = `{
\t"theme": "dark",

\t"mcpServers": {
\t\t"mine": { "command": "my-server", "args": ["--fast"] }
\t}
}`;

test("a document that has not changed is handed back exactly", () => {
  assert.equal(editJson(settings, JSON.parse(settings), "\t"), settings);
});

test("adding a key leaves every other byte alone", () => {
  const value = { ...JSON.parse(settings), hooks: { SessionStart: [] } };
  const edited = editJson(settings, value, "\t");

  // The parts nobody asked to change, still spelled the way they were written.
  assert.match(edited, /\n\n\t"mcpServers"/, "the blank line went");
  assert.match(edited, /"mine": \{ "command": "my-server", "args": \["--fast"\] \}/,
    "a nested object written on one line came back expanded");
  assert.match(edited, /\n\t"hooks": \{/, "the new key is not in the file's own indent");
  // What is written fresh is written at the depth it sits at, not at column 0.
  assert.match(edited, /\n\t\t"SessionStart"/, "a new nested value was left unindented");
  assert.deepEqual(JSON.parse(edited), value);
});

test("removing what was added restores the file byte for byte", () => {
  const original = JSON.parse(settings);
  const installed = editJson(settings,
    { ...original, "acc:owned": ["hooks"], hooks: { SessionStart: [] } }, "\t");

  assert.equal(editJson(installed, original, "\t"), settings);
});

test("a member is removed without leaving the comma that held it", () => {
  const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';

  assert.equal(editJson(text, { b: 2, c: 3 }, "  "), '{\n  "b": 2,\n  "c": 3\n}');
  assert.equal(editJson(text, { a: 1, c: 3 }, "  "), '{\n  "a": 1,\n  "c": 3\n}');
  assert.equal(editJson(text, { a: 1, b: 2 }, "  "), '{\n  "a": 1,\n  "b": 2\n}');
  assert.equal(editJson(text, {}, "  "), "{}");
});

test("a file written on one line is edited on one line", () => {
  assert.equal(editJson('{"a":1}', { a: 1, b: 2 }, 0), '{"a":1,"b":2}');
});

test("only the value that changed is written again", () => {
  // The object around it changed, so it is spliced rather than copied - and
  // splicing keeps the shape it was written in.
  assert.equal(editJson('{\n  "a": { "x": 1 },\n  "b": 2\n}', { a: { x: 9 }, b: 2 }, "  "),
    '{\n  "a": { "x": 9 },\n  "b": 2\n}');
});

test("what cannot be read is refused rather than guessed at", () => {
  // The caller falls back to re-emitting the whole file, which is what it did
  // before this existed. Returning something half-understood would be worse
  // than reformatting.
  assert.equal(editJson("{ not json", { a: 1 }, "  "), null);
  assert.equal(editJson('{\n  // a comment\n  "a": 1\n}', { a: 1, b: 2 }, "  "), null);
  assert.equal(editJson('{"a":1} trailing', { a: 1 }, "  "), null);
  assert.equal(readJson("[1, 2"), null);
  assert.equal(readJson(undefined), null);
});

test("strings that contain the punctuation are not mistaken for it", () => {
  const text = '{\n  "a": "}, \\" not the end",\n  "b": 2\n}';
  const value = JSON.parse(text);

  assert.deepEqual(readJson(text).value, value);
  assert.equal(editJson(text, { ...value, c: 3 }, "  "),
    '{\n  "a": "}, \\" not the end",\n  "b": 2,\n  "c": 3\n}');
});

test("every JSON scalar survives the round trip", () => {
  const text = '{\n  "n": -1.5e3,\n  "t": true,\n  "f": false,\n  "z": null,\n  "e": []\n}';

  assert.deepEqual(readJson(text).value,
    { n: -1500, t: true, f: false, z: null, e: [] });
  assert.equal(editJson(text, JSON.parse(text), "  "), text);
});

test("a key called __proto__ is a key, not an instruction", () => {
  // Read into an ordinary object, `value["__proto__"] = …` sets the prototype
  // rather than adding a member: the key disappeared from what was read, and
  // `same()` would then be comparing against a document that is not on disk -
  // answering "unchanged" for a subtree ACC had just been asked to change.
  const text = '{\n  "__proto__": { "polluted": true },\n  "a": 1\n}';
  const node = readJson(text);

  // The contract in one line: what this reads is what `JSON.parse` reads.
  assert.deepEqual(node.value, JSON.parse(text));
  assert.deepEqual(Object.keys(node.value), ["__proto__", "a"]);
  assert.equal({}.polluted, undefined, "reading a config changed every object");

  const value = { ...JSON.parse(text), b: 2 };
  assert.equal(editJson(text, value, "  "),
    '{\n  "__proto__": { "polluted": true },\n  "a": 1,\n  "b": 2\n}');
});
