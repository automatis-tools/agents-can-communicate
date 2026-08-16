import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { platformPaths } from "../src/platform-paths.mjs";

// Real environments, not this machine's. Resolution has to be a function of the
// inputs, or it is only ever tested on whatever the developer happens to run.
const MACOS = { platform: "darwin", env: { HOME: "/Users/dana" } };
const LINUX = { platform: "linux", env: { HOME: "/home/dana" } };
const LINUX_XDG = { platform: "linux", env: { HOME: "/home/dana",
  XDG_DATA_HOME: "/home/dana/.data", XDG_CONFIG_HOME: "/home/dana/.conf",
  XDG_CACHE_HOME: "/var/tmp/dana-cache" } };
const WINDOWS = { platform: "win32", env: {
  APPDATA: "C:\\Users\\dana\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\dana\\AppData\\Local" } };

test("each platform resolves to its own conventional locations", () => {
  assert.deepEqual(platformPaths(MACOS), {
    data: "/Users/dana/Library/Application Support",
    config: "/Users/dana/Library/Application Support",
    cache: "/Users/dana/Library/Caches",
  });
  assert.deepEqual(platformPaths(LINUX), {
    data: "/home/dana/.local/share",
    config: "/home/dana/.config",
    cache: "/home/dana/.cache",
  });
  assert.deepEqual(platformPaths(WINDOWS), {
    data: "C:\\Users\\dana\\AppData\\Roaming",
    config: "C:\\Users\\dana\\AppData\\Roaming",
    cache: "C:\\Users\\dana\\AppData\\Local",
  });
});

test("XDG variables are honoured on Linux and ignored on macOS", () => {
  assert.deepEqual(platformPaths(LINUX_XDG), {
    data: "/home/dana/.data",
    config: "/home/dana/.conf",
    cache: "/var/tmp/dana-cache",
  });

  // macOS has its own convention, and a stray XDG variable - common on a
  // machine that also runs Linux tooling - must not quietly relocate state.
  const confused = { platform: "darwin",
    env: { ...MACOS.env, XDG_DATA_HOME: "/home/dana/.data" } };
  assert.equal(platformPaths(confused).data,
    "/Users/dana/Library/Application Support");
});

test("Windows falls back to roaming when there is no local app data", () => {
  const roamingOnly = { platform: "win32",
    env: { APPDATA: "C:\\Users\\dana\\AppData\\Roaming" } };

  assert.equal(platformPaths(roamingOnly).cache, "C:\\Users\\dana\\AppData\\Roaming");
});

test("an explicit override wins on every platform", () => {
  for (const base of [MACOS, LINUX, WINDOWS]) {
    const overridden = platformPaths({ ...base, env: { ...base.env,
      ACC_DATA_HOME: "/srv/acc/data", ACC_CONFIG_HOME: "/srv/acc/config",
      ACC_CACHE_HOME: "/srv/acc/cache" } });

    assert.deepEqual(overridden,
      { data: "/srv/acc/data", config: "/srv/acc/config", cache: "/srv/acc/cache" });
  }
});

test("an empty variable is not an override", () => {
  // An exported-but-empty variable is the normal shape of "unset" in a shell
  // script, and treating it as a path puts state at the filesystem root.
  const empty = platformPaths({ ...LINUX, env: { ...LINUX.env, ACC_DATA_HOME: "" } });

  assert.equal(empty.data, "/home/dana/.local/share");
});

test("a home that cannot be resolved is a usage error, not a guess", () => {
  assert.throws(() => platformPaths({ platform: "linux", env: {} }),
    error => error.code === EXIT.USAGE);
  assert.throws(() => platformPaths({ platform: "win32", env: {} }),
    error => error.code === EXIT.USAGE);
});

test("no resolved location is ever inside a workspace", () => {
  // The regression this design exists to prevent: state next to the project,
  // where a clone or a delete takes presence and locks with it. A machine can
  // reach this honestly - XDG_DATA_HOME pointed into a checkout - so it is
  // refused rather than assumed away.
  const workspace = "/home/dana/projects/acc";
  const env = { HOME: "/home/dana", XDG_DATA_HOME: `${workspace}/.acc` };

  // Without the workspace named, there is nothing to check against.
  assert.equal(platformPaths({ platform: "linux", env }).data, `${workspace}/.acc`);

  assert.throws(() => platformPaths({ platform: "linux", env,
    workspaceRoots: [workspace] }), error => error.code === EXIT.USAGE);
});

test("a location beside a workspace is not inside it", () => {
  // `/home/dana/projects/acc-notes` starts with the workspace path as text and
  // is a different directory. Comparison is per segment.
  const resolved = platformPaths({ platform: "linux",
    env: { HOME: "/home/dana", XDG_DATA_HOME: "/home/dana/projects/acc-notes" },
    workspaceRoots: ["/home/dana/projects/acc"] });

  assert.equal(resolved.data, "/home/dana/projects/acc-notes");
});

test("a relative location is refused wherever it comes from", () => {
  assert.throws(() => platformPaths({ ...LINUX,
    env: { ...LINUX.env, ACC_DATA_HOME: "relative/data" } }),
    error => error.code === EXIT.USAGE);
  assert.throws(() => platformPaths({ platform: "linux", env: { HOME: "home/dana" } }),
    error => error.code === EXIT.USAGE);
});
