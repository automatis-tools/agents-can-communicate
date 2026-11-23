# What one ACC start costs: development evidence

This records the measurement for #150 and its development candidate. It is not a published
release.

## Method

For every round, warm-up included, `scripts/measure/cold-start.mjs` creates a new temporary
directory with its own `HOME`, data home, Git project and a `claude` executable that prints a
version, and removes it after the round. So no round reads state that an earlier session left.
Each round is one Claude Code session. The script runs these in order and times each one:

1. `node -e 0`, to show what Node alone costs;
2. the hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse` on a Write, `Stop` and
   `SessionEnd`, through `bin/acc-hook.mjs claude_code` with the client's JSON on stdin;
3. `acc inbox --json` with the owner arguments that the prompt hook printed.

Each command runs under `/bin/sh`. The wall time is taken around the shell. The CPU time is the
user and system time from the shell's `times`, which includes every child process that the
command waited for, such as `git` and the client version probe. A detached worker is not
counted. The script refuses a failed command, a prompt hook that names no owner, a guard that
denies, and an inbox that fails. Warm-up rounds are not recorded.

## Run

- Package: ACC 0.15.3 from the tarball of this branch before its documentation commit, installed
  with npm. Only `docs/ARCHITECTURE.md` differs between it and the candidate below.
- Node 24.4.0, macOS, arm64 (Apple silicon), load average 6.9 before and 7.1 after.
- 30 rounds after 2 warm-up rounds. Raw samples: [run.json](cold-start-2026-11-23/run.json).

| Path | Wall median ms | Wall p95 ms | CPU median ms | CPU p95 ms | p95 of 5 s |
|---|---|---|---|---|---|
| node | 24.4 | 28.6 | 18 | 21 | 1% |
| sessionStart | 236.8 | 306.4 | 162 | 216 | 6% |
| beforeTurn | 114.3 | 150.2 | 120 | 159 | 3% |
| guard | 81.2 | 101 | 83 | 106 | 2% |
| inbox | 79.1 | 105.3 | 83 | 103 | 2% |
| finish | 82.1 | 101.6 | 85 | 107 | 2% |
| sessionEnd | 118 | 154 | 119 | 159 | 3% |

## Result

Every path stays under 7% of the hook runner's 5-second budget at p95. For every path except
session start, CPU time is close to wall time, so a start is CPU work rather than waiting.
Session start waited about 75 ms more than it computed at the median; in each round it was the
first session in a new data home.

An earlier run of this branch gave every round the same project and data home, so later
rounds started in a store that earlier sessions had used. Its session start took 186 ms at p95.
The review of the PR found that it did not match the documented method, and the run above
replaces it. An agent that polls `inbox` every 5 seconds
uses about 1.5% of one core. The issue's comparison point measured 3.9 CPU seconds for one
start of another tool's CLI. No path needed a reduction.

## Exact artifact

- Source: clean commit `6ba2cb5f48285da0e9f5477a0a7156dc9ef5638b`.
- Archive: `agents-can-communicate-0.15.3.tgz`, 665,808 bytes, 393 files.
- SHA-256: `81701faee1eb71f1bbca7ca875c25ce49a9f7c2b8fe6c07fd16d731e3a262ef5`.
- The archive passed `scripts/verify-package.mjs`.

## Tests

`tests/measure/cold-start.test.mjs` checks the `times` parser in bash and dash formats, the
percentiles and the budget share, and runs one real round on the checkout for every path. It
skips that round on Windows.

## Limits

- One machine. Linux and Windows were not measured; on Windows the script refuses to run.
- The data home is new, so the store is small. A store with a long history can make the paths
  that read it slower.
- A managed install runs the hook through its launcher in the data home; that step was not
  measured.
