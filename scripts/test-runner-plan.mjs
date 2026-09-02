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
