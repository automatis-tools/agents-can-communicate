// --test-timeout bounds a test, not handles left behind after it passes.
// Imported into each test-file process; helpers and the parent runner are not
// test files. The unreferenced timer never delays a normally completed file.
import { testFileTimeout } from "./test-runner-plan.mjs";
const file = process.argv[1];
if (file?.endsWith(".test.mjs")) {
  const timeout = testFileTimeout();
  setTimeout(() => {
    console.error(`test file ${file} exceeded ${timeout} ms; unfinished work or cleanup kept it alive`);
    process.exit(1);
  }, timeout).unref();
}
