import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { platformDataHome, runtimePaths } from "../src/runtime-paths.mjs";

const WORKSPACE = "workspace_abc123";
const DATA_HOME = "/home/example/.local/share";

test("every runtime location sits under one workspace directory", () => {
  const paths = runtimePaths({ dataHome: DATA_HOME, workspaceId: WORKSPACE });

  assert.equal(paths.root, path.join(DATA_HOME, "acc", "workspaces", WORKSPACE));
  for (const key of ["protocol", "events", "state", "locks", "ephemeral"]) {
    assert.equal(paths[key].startsWith(`${paths.root}${path.sep}`), true,
      `${key} escaped the workspace runtime root`);
  }
});

test("runtime state never lives inside the workspace it describes", () => {
  // The whole point of a runtime directory is that a project checkout can be
  // deleted, cloned, or synced without carrying presence, locks, or messages.
  const workspaceRoot = "/home/example/projects/demo";
  const paths = runtimePaths({ dataHome: DATA_HOME, workspaceId: WORKSPACE,
    workspaceRoots: [workspaceRoot] });

  assert.equal(paths.root.startsWith(workspaceRoot), false);
  assert.equal(path.relative(workspaceRoot, paths.root).startsWith(".."), true);
});

test("a data home inside the workspace is refused outright", () => {
  // The regression this guards is "just put it in .agents next to the project",
  // which looks like it works until a checkout is cloned or deleted.
  const workspaceRoot = "/home/example/projects/demo";

  assert.throws(() => runtimePaths({ dataHome: path.join(workspaceRoot, ".agents"),
    workspaceId: WORKSPACE, workspaceRoots: [workspaceRoot] }),
  error => error.code === EXIT.USAGE
    && error.message.includes("cannot be a workspace"));

  assert.throws(() => runtimePaths({ dataHome: workspaceRoot, workspaceId: WORKSPACE,
    workspaceRoots: [workspaceRoot] }), error => error.code === EXIT.USAGE);
});

test("the refusal names the directory, the state, and what to do about it", () => {
  // The case a person actually meets is not the one the rule was written for.
  // A home directory is no checkout, so discovery falls back to it - and the
  // platform's own state directory is inside a home by definition. `acc status`
  // in `~` answered "runtime state must not live inside the workspace", which
  // reads as a misconfiguration and gives the reader nothing to act on.
  const home = "/home/example";
  const thrown = (() => {
    try {
      runtimePaths({ dataHome: path.join(home, ".local", "share"),
        workspaceId: WORKSPACE, workspaceRoots: [home] });
      return null;
    } catch (error) {
      return error;
    }
  })();

  assert.notEqual(thrown, null, "a home directory was accepted as a workspace");
  assert.equal(thrown.message.includes(home), true, "the directory is not named");
  assert.equal(thrown.message.includes(path.join(home, ".local", "share", "acc")), true,
    "the state it holds is not named");
  assert.match(thrown.message, /Run acc inside a project/);
  assert.match(thrown.message, /ACC_DATA_HOME/);
  // The workspace's own directory inside the data home is not what a reader can
  // move, so it is in the details rather than the sentence.
  assert.equal(thrown.details.workspaceRoot, home);
});

test("a sibling directory sharing a name prefix is not treated as inside", () => {
  // "/demo-runtime" must not count as inside "/demo": prefix comparison on raw
  // strings is the classic way this check goes wrong.
  const paths = runtimePaths({ dataHome: "/home/example/projects/demo-runtime",
    workspaceId: WORKSPACE, workspaceRoots: ["/home/example/projects/demo"] });

  assert.equal(paths.root.startsWith("/home/example/projects/demo-runtime"), true);
});

test("the ephemeral area is separate from durable state", () => {
  // Lazy materialisation writes presence and Intent here before any durable
  // object exists, so it must not be mistaken for the event log or state.
  const paths = runtimePaths({ dataHome: DATA_HOME, workspaceId: WORKSPACE });

  assert.notEqual(paths.ephemeral, paths.state);
  assert.notEqual(paths.ephemeral, paths.events);
  assert.equal(path.basename(paths.ephemeral), "ephemeral");
});

test("a relative data home is rejected rather than resolved against the cwd", () => {
  assert.throws(() => runtimePaths({ dataHome: ".local/share", workspaceId: WORKSPACE }),
    error => error.code === EXIT.USAGE);
});

test("a path-hostile workspace id is rejected before it becomes a directory", () => {
  for (const workspaceId of ["../escape", "work/space", "", "CON", null]) {
    assert.throws(() => runtimePaths({ dataHome: DATA_HOME, workspaceId }),
      error => error.code === EXIT.DATA, `accepted ${JSON.stringify(workspaceId)}`);
  }
});

test("the platform data home follows XDG on Linux", () => {
  assert.equal(platformDataHome({ platform: "linux",
    env: { XDG_DATA_HOME: "/xdg/data", HOME: "/home/example" } }), "/xdg/data");
  assert.equal(platformDataHome({ platform: "linux", env: { HOME: "/home/example" } }),
    path.join("/home/example", ".local", "share"));
});

test("the platform data home follows the macOS and Windows conventions", () => {
  assert.equal(platformDataHome({ platform: "darwin", env: { HOME: "/Users/example" } }),
    path.join("/Users/example", "Library", "Application Support"));
  assert.equal(platformDataHome({ platform: "win32",
    env: { APPDATA: "C:\\Users\\example\\AppData\\Roaming" } }),
  "C:\\Users\\example\\AppData\\Roaming");
});

test("an explicit override wins over every platform default", () => {
  assert.equal(platformDataHome({ platform: "darwin",
    env: { ACC_DATA_HOME: "/tmp/acc", HOME: "/Users/example" } }), "/tmp/acc");
});

test("an unresolvable home is a usage error, not a silent relative path", () => {
  assert.throws(() => platformDataHome({ platform: "linux", env: {} }),
    error => error.code === EXIT.USAGE);
  assert.throws(() => platformDataHome({ platform: "win32", env: {} }),
    error => error.code === EXIT.USAGE);
});
