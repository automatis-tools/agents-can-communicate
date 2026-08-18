import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * Every documented command, not the ones someone remembered to mark.
 *
 * `commands.test.mjs` runs blocks carrying `<!-- test:command -->`. That is
 * opt-in, and 18 of the 23 `acc` lines in the documentation had never opted in -
 * among them every example of the form
 *
 *     acc work --session "$ACC_SESSION" --generation "$ACC_GENERATION" ...
 *
 * which could not work, because nothing has ever set either variable. It stayed
 * through four rewrites of the skills and three of the docs. Opting in is what
 * let it stay: a line nobody marked is a line nobody ran.
 *
 * So this runs all of them, and asks the weaker question that every one of them
 * can be held to: the CLI must *accept* the command. A document may name a task
 * that does not exist in your workspace - `task_x` is a placeholder and should
 * be - but it may not name a flag the CLI does not have, or tell a reader to
 * expand a variable nothing sets.
 */
const ILLUSTRATION = /<!-- test:illustration([^>]*)-->/g;

/**
 * Everything that tells someone what to run - including the four shipped skills.
 *
 * A skill is documentation with the highest stakes in the project: it is read by
 * an agent that cannot ask a follow-up question, and an instruction it cannot
 * carry out is answered by improvising. One session, finding no `acc`, wrote to
 * the store by hand and reported the work as coordinated.
 */
async function documents() {
  const files = [path.join(repo, "README.md")];
  for (const root of ["docs", "examples"]) {
    for (const entry of await readdir(path.join(repo, root), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(repo, root, entry.name));
      }
    }
  }
  for (const entry of await readdir(path.join(repo, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const bundle of ["plugin", "extension"]) {
      const skill = path.join(repo, "packages", entry.name, bundle, "skills", "acc", "SKILL.md");
      if (await readFile(skill, "utf8").then(() => true, () => false)) files.push(skill);
    }
  }
  return files;
}

/** `acc` invocations in bash blocks, with continuations joined and comments cut. */
function accCommands(text) {
  const found = [];
  for (const block of text.matchAll(/(<!-- test:illustration[^>]*-->\s*)?```bash\n([\s\S]*?)```/g)) {
    if (block[1] !== undefined) continue;
    const joined = block[2].replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n")) {
      const command = line.replace(/\s+#.*$/, "").trim();
      // A skill ships `{{ACC}}`, replaced with a real command at install time.
      // Both forms are instructions someone is meant to run.
      if (command.startsWith("acc ") || command.startsWith("{{ACC}} ")) found.push(command);
    }
  }
  return found;
}

/** Split a command line, honouring the quoting the documentation actually uses. */
function argv(command) {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.slice(1).map(part => (/^["']/.test(part) ? part.slice(1, -1) : part));
}

/**
 * A sandbox with a session already attached, because that is the situation the
 * documentation describes. Attached through the hook runtime rather than `acc
 * attach`, so what the commands resolve against is what a real client leaves
 * behind.
 */
async function sandbox(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exec-home-")));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exec-cwd-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exec-data-")));
  t.after(() => Promise.all([home, cwd, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));
  const env = { ...process.env, HOME: home, ACC_DATA_HOME: dataHome,
    GIT_DIR: "", GIT_WORK_TREE: "" };

  const child = run(process.execPath, [path.join(repo, "bin", "acc-hook.mjs"), "codex"],
    { env: { ...env, ACC_PARTICIPANT: "reader" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: "docs-reader", cwd, source: "startup" }));
  await child;
  return { home, cwd, dataHome, env };
}

test("every documented acc command is one the CLI accepts", async t => {
  const rejected = [];
  let checked = 0;

  for (const file of await documents()) {
    const commands = accCommands(await readFile(file, "utf8"));
    if (commands.length === 0) continue;
    // One sandbox per document, because a document is what a reader follows.
    // Sharing one made `acc finish` in the CLI reference close the session that
    // every later document's commands then failed to find.
    const place = await sandbox(t);
    for (const command of commands) {
      checked += 1;
      const parts = argv(command);
      const result = await run(process.execPath,
        [path.join(repo, "bin", "acc.mjs"), ...parts, "--cwd", place.cwd,
          ...(parts.includes("--json") ? [] : ["--json"])],
        { env: place.env })
        .then(() => ({ code: 0 }), error => ({ code: error.code, stdout: error.stdout ?? "" }));
      // Exit 2 is the parser refusing: an option that does not exist, a value
      // missing, a required argument absent. Anything deeper is the command
      // working on a workspace this sandbox does not have, which is fine.
      if (result.code === EXIT.USAGE) {
        const reported = JSON.parse(result.stdout || "{}").error?.message ?? "";
        rejected.push(`${path.relative(repo, file)}: ${command}\n    ${reported}`);
      }
    }
  }

  assert.equal(checked > 15, true, `only ${checked} documented commands were found`);
  assert.deepEqual(rejected, [],
    `documentation tells a reader to run something the CLI refuses:\n  ${rejected.join("\n  ")}`);
});

/**
 * A `$VAR` in a documented command is a promise that something sets it.
 *
 * `$ACC_SESSION` was in seven files for months. It reads exactly like a variable
 * the runtime provides, and nothing has ever provided it - and the gate above
 * cannot catch it, because a command carrying an unexpanded variable is still a
 * command the parser accepts. Neither can a reader: `$CLAIM` next to it was a
 * placeholder for a value they were meant to type, and the two look identical.
 *
 * So the documentation does not use `$VAR` for a value the reader supplies. It
 * uses a visibly false literal - `task_x`, `claim_x` - the way the rest of it
 * already did.
 */
const EXPORTED = Object.freeze(new Set(["HOME", "PATH", "ACC_DATA_HOME", "ACC_PARTICIPANT"]));

test("no documented command expands a variable nothing sets", async () => {
  const unset = [];
  for (const file of await documents()) {
    const text = await readFile(file, "utf8");
    for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
      const body = block[1];
      const assigned = new Set([...body.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/gm)]
        .map(match => match[1]));
      for (const command of accCommands(`\`\`\`bash\n${body}\`\`\``)) {
        for (const [, name] of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
          if (assigned.has(name) || EXPORTED.has(name)) continue;
          unset.push(`${path.relative(repo, file)}: $${name} in \`${command}\``);
        }
      }
    }
  }

  assert.deepEqual(unset, [],
    "documentation expands a variable that is neither set in the block nor by the runtime");
});

test("a block excused from running says so in the document", async () => {
  // The excuse is a decision, visible in the file being read, rather than the
  // absence of a marker somewhere else. Anything opted out has to be worth
  // opting out - so this fails if the escape hatch starts carrying the load.
  let illustrations = 0;
  for (const file of await documents()) {
    const text = await readFile(file, "utf8");
    for (const [, reason] of text.matchAll(ILLUSTRATION)) {
      illustrations += 1;
      assert.notEqual(reason.trim(), "",
        `${path.relative(repo, file)} excuses a block from running without saying why`);
    }
  }
  assert.equal(illustrations <= 2, true,
    `${illustrations} blocks are excused from running; the marker is becoming the rule`);
});
