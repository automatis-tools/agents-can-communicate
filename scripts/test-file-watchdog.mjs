// --test-timeout bounds a test, not handles left behind after it passes.
// Imported into each test-file process; helpers and the parent runner are not
// test files. The unreferenced timer never delays a normally completed file.
import { testFileTimeout } from "./test-runner-plan.mjs";
const file = process.argv[1];
if (file?.endsWith(".test.mjs")) {
  const timeout = testFileTimeout();
  setTimeout(() => {
    // The resource types say what to look for when the hang cannot be reproduced.
    const holders = process.getActiveResourcesInfo().join(", ") || "none reported";
    console.error(`test file ${file} exceeded ${timeout} ms; unfinished work or cleanup kept it alive`
      + `\ntest file ${file} kept alive by: ${holders}`);
    process.exit(1);
  }, timeout).unref();
}
