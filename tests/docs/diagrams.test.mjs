import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * Diagrams that are checked rather than eyeballed.
 *
 * A mermaid block that does not parse renders as an error box on GitHub, and
 * nothing in a normal review catches it - the source looks fine. One shipped to
 * main exactly that way.
 *
 * These rules are measured against mermaid 11, not guessed. Every one of them
 * was confirmed by parsing the rejected form and its accepted twin; the twins
 * are in the proving tests at the bottom, so a rule that stops working cannot
 * sit here looking protective. Constructs that merely *look* dangerous and in
 * fact parse - a semicolon inside a flowchart label, `**` or a colon inside a
 * sequence message, an unquoted multi-word subgraph title - are deliberately
 * not rules. Guarding them would fail live diagrams for no reason.
 */
const TYPES = ["graph", "flowchart", "sequenceDiagram"];

// `[` NOT followed by a shape character, so `S[(cylinder)]`, `A[[subroutine]]`,
// `A[/parallelogram/]` keep their own delimiters instead of being read as a
// rectangle whose text happens to start with one.
const RECTANGLE = /\[(?![([/\\])([^\]]*)\]/g;

const quoted = label => label.startsWith('"') && label.endsWith('"') && label.length > 1;

/** Every ```mermaid block in a file, with the line it starts on. */
function blocksIn(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*```mermaid\s*$/.test(lines[index])) continue;
    const start = index + 1;
    let end = start;
    while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) end += 1;
    assert.equal(end < lines.length, true, `unclosed mermaid block at line ${index + 1}`);
    blocks.push({ line: index + 1, source: lines.slice(start, end).join("\n") });
    index = end;
  }
  return blocks;
}

/** Rule violations in one block. Empty means the block obeys every rule. */
export function violations(source) {
  const lines = source.split("\n").filter(line => line.trim() !== "");
  const type = TYPES.find(name => lines[0]?.trim().startsWith(name));
  if (type === undefined) return [`unknown diagram type: ${lines[0]?.trim() ?? "(empty)"}`];

  const found = [];
  for (const line of lines.slice(1)) {
    if (type === "sequenceDiagram") {
      // `;` is a statement separator in the sequence grammar and legal nowhere
      // else. Measured: it breaks message text, `Note over`, `Note right of`,
      // `loop`/`alt` labels, and `participant ... as` aliases alike - the first
      // scope of this rule was arrow messages only, and it promptly missed a
      // `Note over` in this repository's own docs. Writing two statements on
      // one line is the only legal use and is not a style used here, so the
      // rule is the whole block.
      if (line.includes(";")) found.push(`";" inside a sequence diagram: ${line.trim()}`);
      continue;
    }
    for (const [, label] of line.matchAll(RECTANGLE)) {
      if (/[()]/.test(label) && !quoted(label)) {
        found.push(`unquoted parenthesis in a node label: ${label}`);
      }
    }
  }
  return found;
}

const documents = async () => {
  const roots = [repo, path.join(repo, "docs"), path.join(repo, "examples")];
  const files = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.join(root, entry.name));
    }
  }
  return files.sort();
};

test("every published diagram obeys the rules mermaid actually enforces", async () => {
  const files = await documents();
  let count = 0;

  for (const file of files) {
    for (const block of blocksIn(await readFile(file, "utf8"))) {
      count += 1;
      const found = violations(block.source);
      assert.deepEqual(found, [],
        `${path.relative(repo, file)}:${block.line}\n${found.join("\n")}`);
    }
  }

  // A scan of nothing is not a pass. The README alone carries two diagrams.
  assert.equal(count > 2, true, `only ${count} diagram(s) found - the scan lost its corpus`);
});

test("the semicolon rule catches the line that actually shipped broken", () => {
  // Verbatim from README.md before the fix, and its replacement. mermaid 11
  // rejects the first and accepts the second.
  const broken = "sequenceDiagram\n  ACC-->>C: 2 peers; file:src/** claimed by models";
  const fixed = "sequenceDiagram\n  ACC-->>C: 2 peers · file:src/** claimed by models";

  assert.equal(violations(broken).length, 1);
  assert.deepEqual(violations(fixed), []);
});

test("the semicolon rule covers every text-carrying sequence statement", () => {
  // Each of these was rejected by mermaid 11. The rule missed all but the first
  // when its scope was arrow messages, which is how a broken `Note over` got
  // written in this repository after the message rule was already in place.
  for (const source of [
    "sequenceDiagram\n  A->>B: two peers; one claim",
    "sequenceDiagram\n  participant A\n  Note over A: one; two",
    "sequenceDiagram\n  participant A\n  Note right of A: one; two",
    "sequenceDiagram\n  A->>B: x\n  loop one; two\n    A->>B: y\n  end",
    "sequenceDiagram\n  participant A as one; two",
  ]) {
    assert.equal(violations(source).length, 1, source);
  }
});

test("the semicolon rule does not fire where mermaid allows one", () => {
  // Measured: `;` inside a flowchart parses everywhere it was tried. A rule
  // that banned it in both dialects would fail working diagrams.
  assert.deepEqual(violations("graph LR\n  A[two peers; one claim] --> B[ok]"), []);
  assert.deepEqual(violations("graph LR\n  A -->|two; three| B"), []);
  assert.deepEqual(violations("graph LR\n  subgraph one; two\n    A --> B\n  end"), []);
  assert.deepEqual(violations("sequenceDiagram\n  participant ACC\n  A->>B: no separator"), []);
});

test("the parenthesis rule distinguishes a rectangle from a shape", () => {
  assert.equal(violations("graph LR\n  A[session starts (hook)] --> B[ok]").length, 1);
  assert.deepEqual(violations('graph LR\n  A["session starts (hook)"] --> B[ok]'), []);
  // `[(` opens a cylinder; the parentheses are its delimiters, not its text.
  assert.deepEqual(violations("graph TB\n  ACC --> S[(runtime state)]"), []);
  assert.deepEqual(violations("graph TB\n  A --> B[[subroutine]]"), []);
});

test("a block with no recognised diagram type is a violation", () => {
  assert.equal(violations("graf LR\n  A --> B").length, 1);
  assert.equal(violations("").length, 1);
});
