import assert from "node:assert/strict";
import test from "node:test";

import { isolatedEnv } from "./helpers/packed-acc.mjs";

// A packed fixture installs and runs its own ACC against its own data home. Any
// ACC_* the developer exported describes their machine, not this test. A leaked
// ACC_NATIVE_DELIVERY_POLICY made a session bind natively during setup and the
// turn-lifecycle suite then observed two handshakes where it asserts one.
test("a packed fixture never inherits the caller's ACC configuration", () => {
  const env = isolatedEnv({
    PATH: "/inherited/bin", HOME: "/real/home", LANG: "en_US.UTF-8",
    ACC_SESSION: "session_real", ACC_GENERATION: "generation_real",
    ACC_NATIVE_DELIVERY_POLICY: "actionable", ACC_DATA_HOME: "/real/data",
    ACC_SOMETHING_FUTURE: "leaked",
  }, { ACC_NO_UPDATE_CHECK: "1", ACC_DATA_HOME: "/fixture/data",
    HOME: "/fixture/home", PATH: "/fixture/bin" });

  for (const key of ["ACC_SESSION", "ACC_GENERATION", "ACC_NATIVE_DELIVERY_POLICY",
    "ACC_SOMETHING_FUTURE"]) {
    assert.equal(env[key], undefined, `${key} must not reach the fixture`);
  }
  // What the fixture sets on purpose survives the scrub.
  assert.equal(env.ACC_DATA_HOME, "/fixture/data");
  assert.equal(env.ACC_NO_UPDATE_CHECK, "1");
  assert.equal(env.HOME, "/fixture/home");
  assert.equal(env.PATH, "/fixture/bin");
  // Unrelated environment still reaches the child, so the shell stays usable.
  assert.equal(env.LANG, "en_US.UTF-8");
});

test("the scrub does not mutate the environment it was given", () => {
  const inherited = { ACC_NATIVE_DELIVERY_POLICY: "all", LANG: "C" };
  isolatedEnv(inherited, { ACC_DATA_HOME: "/fixture/data" });
  assert.equal(inherited.ACC_NATIVE_DELIVERY_POLICY, "all");
});
