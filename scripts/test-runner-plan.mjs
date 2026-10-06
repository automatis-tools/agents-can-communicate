// The suite contains tests that deliberately create several independent ACC,
// npm, tar, and Unix-socket processes. Letting Node run one test file per CPU
// (18 on the release machine) multiplies those process races until a healthy
// writer cannot be scheduled inside its hook-safe acquisition deadline.
// Bounding only file-level concurrency preserves the concurrency inside those
// tests while keeping the release gate deterministic.
//
// Windows takes three. Two came first (2026-09-30), when the suite's temporary
// files lived on the runner's remote system disk: a flush there took 8 to 23 ms
// and four heavy files at once left a hook in another file past its five-second
// budget. CI has kept them on the local disk since (a flush in 0.2-0.5 ms), and on
// one windows-latest CPU (EPYC 7763) the suite then took 771 s at two, 618 and
// 631 s at three, 590 s at four, with no failure (2026-10-06). At four each file
// took half as long again as at two, at three a fifth longer: three keeps more
// of the hooks' margin for nearly all of the gain.
export const fileConcurrency = (platform = process.platform) => (platform === "win32" ? 3 : 4);
export const TEST_FILE_CONCURRENCY = fileConcurrency();

// CI sets ACC_TEST_TIMEOUT_MS so that one hung test fails with its name instead
// of holding the whole job until the runner's own limit.
const perTestTimeout = () => {
  const value = Number(process.env.ACC_TEST_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? [`--test-timeout=${value}`] : [];
};

// ACC_TEST_FORCE_EXIT ends a file's process once its tests are done, so a child
// process a failed test left behind cannot hold a concurrency slot for good.
const forceExit = () => (process.env.ACC_TEST_FORCE_EXIT === "1" ? ["--test-force-exit"] : []);

export const nodeTestArguments = files => [
  "--test",
  `--test-concurrency=${TEST_FILE_CONCURRENCY}`,
  ...perTestTimeout(),
  ...forceExit(),
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
