import assert from "node:assert/strict";
import test from "node:test";

import { shellWriteTargets } from "../src/shell-writes.mjs";

/**
 * A claim is only worth what the guard can see.
 *
 * Every case here was written against a command an agent actually reached for,
 * or one a careless reader of the rules would reach for next. The list is
 * deliberately not exhaustive - a shell can always evade it - so each test says
 * which side of the line it is proving: a write that must be seen, or a read
 * that must not be mistaken for one.
 */

test("a redirection names the file it would overwrite", () => {
  assert.deepEqual(shellWriteTargets("printf '%s\\n' '// via shell' >> src/parser.mjs"),
    ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("echo x > notes.txt"), ["notes.txt"]);
  assert.deepEqual(shellWriteTargets("node build.mjs 2> build.log"), ["build.log"]);
});

test("reading is not writing", () => {
  // The whole point of scoping to write positions: a command may name a claimed
  // file and still leave it alone.
  assert.deepEqual(shellWriteTargets("cat src/parser.mjs"), []);
  assert.deepEqual(shellWriteTargets("grep -n parse src/parser.mjs"), []);
  assert.deepEqual(shellWriteTargets("node --test src/parser.test.mjs"), []);
  assert.deepEqual(shellWriteTargets("sed 's/a/b/' src/parser.mjs"), []);
});

test("a redirection that reads is not a redirection that writes", () => {
  // `<` feeds a file in. Counting it would block a session for reading a peer's
  // file through a shell, which is exactly the over-reach this guard avoids.
  assert.deepEqual(shellWriteTargets("node build.mjs < src/parser.mjs"), []);
  assert.deepEqual(shellWriteTargets("wc -l < src/parser.mjs"), []);
  assert.deepEqual(shellWriteTargets("node - <<< 'console.log(1)'"), []);
});

test("the sink that discards is not a file anyone claims", () => {
  assert.deepEqual(shellWriteTargets("npm test > /dev/null"), []);
  assert.deepEqual(shellWriteTargets("npm test 2>&1"), []);
  assert.deepEqual(shellWriteTargets("npm test > /dev/null 2>&1"), []);
});

test("editing in place is a write, and the script is not a file", () => {
  assert.deepEqual(shellWriteTargets("sed -i '' 's/a/b/' src/parser.mjs"),
    ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("sed -i.bak -e 's/a/b/' src/parser.mjs"),
    ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("perl -i -pe 's/a/b/' src/parser.mjs"),
    ["src/parser.mjs"]);
});

test("the commands whose whole job is to put bytes somewhere", () => {
  assert.deepEqual(shellWriteTargets("tee src/parser.mjs"), ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("tee -a src/parser.mjs"), ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("touch src/parser.mjs"), ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("truncate -s 0 src/parser.mjs"), ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("dd if=/dev/zero of=src/parser.mjs"), ["src/parser.mjs"]);
});

test("removing a file is the most complete write there is", () => {
  assert.deepEqual(shellWriteTargets("rm src/parser.mjs"), ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("rm -rf src/parser.mjs"), ["src/parser.mjs"]);
});

test("copying and moving write the destination, and moving empties the source", () => {
  assert.deepEqual(shellWriteTargets("cp /tmp/new.mjs src/parser.mjs"), ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("mv src/parser.mjs src/old.mjs").sort(),
    ["src/old.mjs", "src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("ln -sf /tmp/other src/parser.mjs"), ["src/parser.mjs"]);
});

test("restoring from git overwrites whatever a peer was holding", () => {
  assert.deepEqual(shellWriteTargets("git restore src/parser.mjs"), ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("git checkout -- src/parser.mjs"), ["src/parser.mjs"]);
  // Reading history is not writing the tree.
  assert.deepEqual(shellWriteTargets("git log -1 -- src/parser.mjs"), []);
  assert.deepEqual(shellWriteTargets("git diff src/parser.mjs"), []);
});

test("every command in a chain is looked at, not just the first", () => {
  assert.deepEqual(shellWriteTargets("npm test && printf x > src/parser.mjs"),
    ["src/parser.mjs"]);
  assert.deepEqual(shellWriteTargets("cd src; rm parser.mjs"), ["parser.mjs"]);
  assert.deepEqual(shellWriteTargets("cat in.txt | tee src/parser.mjs"), ["src/parser.mjs"]);
});

test("a redirection inside quotes is text, not a redirection", () => {
  assert.deepEqual(shellWriteTargets("echo 'a > b'"), []);
  assert.deepEqual(shellWriteTargets('echo "write > nothing"'), []);
  assert.deepEqual(shellWriteTargets("git commit -m 'move a > b'"), []);
});

test("a heredoc body is content, and the redirection before it is real", () => {
  const command = "cat > src/parser.mjs <<'EOF'\n"
    + "// this line > is not a redirection\n"
    + "rm everything.mjs\n"
    + "EOF";
  assert.deepEqual(shellWriteTargets(command), ["src/parser.mjs"]);
});

test("a command it cannot read leaves the guard where it found it", () => {
  // Fail open, never throw: an unparseable command must not take the hook down,
  // and must not invent a target either.
  for (const command of ["", "   ", "python3 -c \"open('src/parser.mjs','w')\"",
    "eval \"$CMD\"", "((", "'unterminated"]) {
    assert.deepEqual(shellWriteTargets(command), [],
      `expected no targets from: ${command}`);
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.deepEqual(shellWriteTargets(bad), [], `expected no targets from: ${bad}`);
  }
});

test("the same file named twice is reported once", () => {
  assert.deepEqual(shellWriteTargets("rm src/parser.mjs && touch src/parser.mjs"),
    ["src/parser.mjs"]);
});
