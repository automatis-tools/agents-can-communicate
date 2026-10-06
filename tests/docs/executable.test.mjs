import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { fixtureOwnerEnv } from "../helpers/fixture-owner.mjs";
import { createDocsExecutor } from "../helpers/docs-executor.mjs";
import { removeFixture } from "../helpers/fixture-cleanup.mjs";
import { runtimeWorkersQuiet } from "../helpers/runtime-workers.mjs";

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
 * Command syntax with explicit fixture credentials. This checks accepted CLI
 * vocabulary, not whether a real client supplies owner credentials. Real-client
 * ownership needs its own installed-artifact capture.
 */
async function sandbox(t, executor) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exec-home-")));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exec-cwd-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exec-data-")));
  // `acc install` starts ACC's detached runtime worker in this data home.
  t.after(async () => {
    await runtimeWorkersQuiet(dataHome);
    await Promise.all([home, cwd, dataHome].map(removeFixture));
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    GIT_DIR: "", GIT_WORK_TREE: "" };

  await executor.hook("codex", { hook_event_name: "SessionStart",
    session_id: "docs-reader", cwd, source: "startup" },
    { env: { ...env, ACC_PARTICIPANT: "reader" } });
  return { home, cwd, dataHome, env: { ...env, ...await fixtureOwnerEnv(dataHome, "docs-reader") } };
}

// A history cursor must exist in the selected list. Unlike an exact message
// placeholder, an unknown cursor is a usage error. Obtain one through the
// public API so the documented continuation command is actually exercised.
async function historyCursor(place, executor) {
  const cli = async args => JSON.parse((await executor.cli(
    [...args, "--cwd", place.cwd, "--json"],
    { env: place.env })).stdout).data;
  for (let i = 0; i < 2; i += 1) {
    const session = await cli(["attach", "--participant", `docs_history_${i}`]);
    await cli(["finish", "--session", session.sessionId, "--generation", session.generation,
      "--goal", "Example historical handoff"]);
  }
  const page = await cli(["sync", "--scope", "history", "--type", "handoff", "--limit", "1"]);
  assert.ok(page.nextCursor, "history fixture did not create a continuation cursor");
  return page.nextCursor;
}

// The newest event sequence this workspace has issued, which is what a history
// boundary has to name. A message-history cursor is a message id and would be
// refused.
async function eventCursor(place, executor) {
  const page = JSON.parse((await executor.cli(
    ["sync", "--cwd", place.cwd, "--json"],
    { env: place.env })).stdout).data;
  assert.ok(/^[0-9]{16}$/.test(page.cursor), "sync did not return an event cursor");
  return page.cursor;
}

test("every documented acc command is one the CLI accepts", async t => {
  const executor = await createDocsExecutor(t, repo);
  const state = () => ({ env: process.env, argv: process.argv, cwd: process.cwd(),
    exitCode: process.exitCode, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    homedir: homedir() });
  const original = state();
  const originalEnv = { ...process.env };
  const restored = () => {
    for (const [name, value] of Object.entries(original)) assert.ok(state()[name] === value, `leaked process.${name}`);
    const changed = [...new Set([...Object.keys(process.env), ...Object.keys(originalEnv)])]
      .filter(name => process.env[name] !== originalEnv[name]);
    assert.deepEqual(changed, [], "leaked environment variable names");
  };
  const exit = async (args, env) => executor.cli(args, { env })
    .then(() => 0, error => {
      if (error.docsExecutorFailure || !Number.isInteger(error.code)) throw error;
      return error.code;
    });
  const rejected = [];
  let checked = 0;
  let previousOwner = null;
  let sandboxes = 0;

  for (const file of await documents()) {
    const commands = accCommands(await readFile(file, "utf8"));
    if (commands.length === 0) continue;
    // One sandbox per document, because a document is what a reader follows.
    // Sharing one made `acc finish` in the CLI reference close the session that
    // every later document's commands then failed to find.
    const place = await sandbox(t, executor);
    sandboxes += 1;
    restored();
    // Negative controls require both the actual parser and a handler-specific
    // rule; a parser-only shortcut cannot make this documentation gate pass.
    if (previousOwner === null) {
      assert.deepEqual(await Promise.all([
        exit(["sync", "--docs-unknown-option", "--cwd", place.cwd, "--json"], place.env),
        exit(["inbox", "--message", "message_x", "--limit", "1", "--cwd", place.cwd, "--json"], place.env),
      ]), [EXIT.USAGE, EXIT.USAGE], "parser/handler controls must reject invalid commands");
    } else {
      assert.equal(await exit(["inbox", "--cwd", place.cwd, "--json"],
        { ...place.env, ...previousOwner }), EXIT.CONFLICT, "another document's owner must be refused");
    }
    assert.equal(await exit(["inbox", "--cwd", place.cwd, "--json"], place.env), 0,
      "each document must have its own usable owner");
    restored();
    previousOwner = { ACC_SESSION: place.env.ACC_SESSION, ACC_GENERATION: place.env.ACC_GENERATION };
    for (const command of commands) {
      checked += 1;
      const parts = argv(command);
      const cursor = parts.indexOf("--cursor");
      if (parts[0] === "sync" && parts.includes("history")
        && cursor !== -1 && parts[cursor + 1] === "message_x") {
        parts[cursor + 1] = await historyCursor(place, executor);
      }
      // `prune --before` refuses a boundary the store never issued, so the
      // documented example is given one the store just handed out. Obtained
      // through the public API for the same reason the history cursor is: the
      // documented command is then actually exercised rather than skipped.
      const before = parts.indexOf("--before");
      if (parts[0] === "prune" && before !== -1 && parts[before + 1] === "event_cursor") {
        parts[before + 1] = await eventCursor(place, executor);
      }
      const result = await executor.cli(
        [...parts, "--cwd", place.cwd,
          ...(parts.includes("--json") ? [] : ["--json"])],
        { env: place.env })
        .then(() => ({ code: 0 }), error => {
          if (error.docsExecutorFailure || !Number.isInteger(error.code)) throw error;
          return { code: error.code, stdout: error.stdout ?? "" };
        }).finally(restored);
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
  assert.equal(executor.stats.hooks, sandboxes, "every document must run SessionStart");
  assert.ok(executor.stats.nested > 0, "install must execute the staged generation's version check");
  assert.equal(executor.stats.subprocesses, 0, "documentation execution must not fork ACC");
  t.diagnostic(`${checked} documented commands; ${executor.stats.cli} CLI, ${sandboxes} hook, `
    + `${executor.stats.nested} installed-version entrypoint calls`);
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
