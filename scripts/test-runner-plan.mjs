// The suite contains tests that deliberately create several independent ACC,
// npm, tar, and Unix-socket processes. Letting Node run one test file per CPU
// (18 on the release machine) multiplies those process races until a healthy
// writer cannot be scheduled inside its hook-safe acquisition deadline.
// Bounding only file-level concurrency preserves the concurrency inside those
// tests while keeping the release gate deterministic.
export const TEST_FILE_CONCURRENCY = 4;

export const nodeTestArguments = files => [
  "--test",
  `--test-concurrency=${TEST_FILE_CONCURRENCY}`,
  ...files,
];

// Windows caps a command line at 32,767 characters, and 345 absolute test paths
// passed it on windows-latest: the suite failed to start at all. The runner
// passes repository-relative paths and splits them into batches that stay under
// this limit, with room left for the interpreter path and quoting.
export const COMMAND_LINE_LIMIT = 30_000;

// What Windows sees: each word quoted when needed, words joined by a space.
export const commandLineLength = argv =>
  argv.reduce((total, word) => total + String(word).length + 3, 0);

export function testBatches(files, { limit = COMMAND_LINE_LIMIT, interpreter = process.execPath } = {}) {
  const head = commandLineLength([interpreter, ...nodeTestArguments([])]);
  const batches = [];
  let batch = [];
  let length = head;
  for (const file of files) {
    const cost = commandLineLength([file]);
    if (batch.length > 0 && length + cost > limit) {
      batches.push(batch);
      batch = [];
      length = head;
    }
    batch.push(file);
    length += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
