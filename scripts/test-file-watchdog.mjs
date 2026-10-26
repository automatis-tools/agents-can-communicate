// --test-timeout bounds a test, not handles left behind after it passes.
// Imported into each test-file process; helpers and the parent runner are not
// test files. The unreferenced timer never delays a normally completed file.
import { testFileTimeout } from "./test-runner-plan.mjs";
const file = process.argv[1];
if (file?.endsWith(".test.mjs")) {
  const timeout = testFileTimeout();
  // Ahead of the parent's deadline for this file. Node hands a file's results
  // to reporters only when the file ends, and a parent kill also loses what the
  // file printed (#323). Ending the file first keeps both: the run continues,
  // and its closing summary names the failure.
  const ahead = Math.min(5_000, Math.floor(timeout / 10));
  setTimeout(() => {
    // The resource types say what to look for when the hang cannot be reproduced.
    const holders = process.getActiveResourcesInfo().join(", ") || "none reported";
    console.error(`test file ${file} exceeded ${timeout} ms; unfinished work or cleanup kept it alive`
      + `\ntest file ${file} kept alive by: ${holders}`);
    process.exit(1);
  }, timeout - ahead).unref();
}
