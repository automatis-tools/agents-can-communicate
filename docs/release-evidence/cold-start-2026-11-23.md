# What one ACC start costs: development evidence

This records the measurement for #150 and its development candidate. It is not a published
release.

## Method

`scripts/measure/cold-start.mjs` creates a temporary directory with its own `HOME`, data home,
Git project and a `claude` executable that prints a version. Each round is one Claude Code
session. The script runs these in order and times each one:

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
- Node 24.4.0, macOS, arm64 (Apple silicon), load average 7.1 before and 6.9 after.
- 30 rounds after 2 warm-up rounds. Raw samples: [run.json](cold-start-2026-11-23/run.json).

| Path | Wall median ms | Wall p95 ms | CPU median ms | CPU p95 ms | p95 of 5 s |
|---|---|---|---|---|---|
| node | 24.3 | 27.5 | 18 | 18 | 1% |
| sessionStart | 172.9 | 185.5 | 165 | 174 | 4% |
| beforeTurn | 129.1 | 135.9 | 135 | 142 | 3% |
| guard | 93.9 | 102.3 | 97 | 106 | 2% |
| inbox | 77.6 | 87 | 78 | 89 | 2% |
| finish | 82.9 | 86.4 | 84 | 89 | 2% |
| sessionEnd | 117.7 | 137.2 | 119 | 137 | 3% |

## Result

Every path stays under 4% of the hook runner's 5-second budget at p95. CPU time is close to wall
time, so a start is CPU work rather than waiting. An agent that polls `inbox` every 5 seconds
uses about 1.5% of one core. The issue's comparison point measured 3.9 CPU seconds for one
start of another tool's CLI. No path needed a reduction.

## Exact artifact

- Source: clean commit `9665a1d5bdc4a036933903631655fbe8149bdc7a`.
- Archive: `agents-can-communicate-0.15.3.tgz`, 665,721 bytes, 393 files.
- SHA-256: `9bd117416c7b71fd9cbc12ce803150bc0187ddcb573f867216e924706221131e`.
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
