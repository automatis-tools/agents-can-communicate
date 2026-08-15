### Task 8: Strict CLI and machine-readable output

**Files:**

- Create: `tools/agents/lib/args.mjs`
- Create: `tools/agents/comms.mjs`
- Modify: `tests/tools/agent_comms/helpers.mjs`
- Create: `tests/tools/agent_comms/args.test.mjs`
- Create: `tests/tools/agent_comms/integration.test.mjs`

**Interfaces:**

- `parseArgs(argv) -> { command, options }`; unknown commands/options and missing values throw usage exit `2`.
- `main(argv, runtime) -> Promise<number>` where runtime injects `cwd`, `env`, stdin, stdout, stderr, time, PID liveness, UUID, scheduler, and Git query.
- Human commands write only human text; `--json` writes exactly one JSON value; `watch` writes JSONL only.
- Repeated-value grammar is fixed: `register --ownership <scope>` may repeat; `send`/`reply` use exactly one of `--body`, `--body-file`, or stdin and may repeat `--attachment <repo-path>` or `--ephemeral-attachment <artifact-path>`; `handoff` repeats `--changed <path>`, `--follow-up <agent>`, and `--artifact <path>`, while structured verification/contracts and limitations are supplied by `--verification-file`, `--contracts-file`, and `--limitations-file`; `release --force-stale` also requires `--owner <agent>`.

- [ ] **Step 1: Write parser and black-box CLI tests for every currently implemented command and exit code**

```js
test("wait timeout exits three without stderr noise", async () => {
  const result = await runCli(fixture, ["wait", "--id", "visual", "--timeout", "0.01"]);
  assert.equal(result.code, 3);
  assert.equal(result.stderr, "");
});

test("json status is one parseable value", async () => {
  const result = await runCli(fixture, ["status", "--json"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).protocol, { schema_version: 1 });
});

test("unknown options are usage errors", () => {
  assert.throws(
    () => parseArgs(["status", "--mystery"]),
    error => error.exitCode === EXIT.USAGE,
  );
});
```

Exercise `init`, `register`, `close`, `send` with body/body-file/stdin, `broadcast`, `inbox`, `ack`, `reply`, `watch`, `wait`, `claim`, `release`, `handoff`, `status`, and `doctor`. Assert exit codes `0`, `2`, `3`, `4`, `5`, and `6` through actual subprocesses. Verify `comms.mjs` is executable and its shebang is `#!/usr/bin/env node`. Task 9 adds and tests `prompt` after the committed template exists.

`release` accepts `--force-stale --owner <agent>` only when `--id` belongs to the registered orchestrator; ordinary release remains owner-only.

- [ ] **Step 2: Run black-box tests and capture the RED**

Run: `node --test tests/tools/agent_comms/integration.test.mjs`

Expected: exit `1` because the executable and parser do not exist.

- [ ] **Step 3: Implement strict parsing and thin dispatch**

```js
const COMMANDS = Object.freeze({
  init: runInit,
  register: runRegister,
  close: runClose,
  send: runSend,
  broadcast: runBroadcast,
  inbox: runInbox,
  ack: runAck,
  reply: runReply,
  watch: runWatch,
  wait: runWait,
  claim: runClaim,
  release: runRelease,
  handoff: runHandoff,
  status: runStatus,
  doctor: runDoctorCommand,
});
```

The executable catches only `CommsError`, prints its message to stderr, and returns its stable exit code; unexpected exceptions print a stack and return `1`. It discovers bus paths once and passes a shared context to command modules. `SIGINT` and `SIGTERM` call the active watcher's async `stop()` before process exit.

- [ ] **Step 4: Run complete protocol tests GREEN**

Run: `node --test tests/tools/agent_comms/*.test.mjs`

Expected: all protocol tests pass and exit `0`.

- [ ] **Step 5: Commit executable CLI**

```bash
git add tools/agents/comms.mjs tools/agents/lib/args.mjs tests/tools/agent_comms/helpers.mjs tests/tools/agent_comms/args.test.mjs tests/tools/agent_comms/integration.test.mjs
git commit -m "feat: expose agent communication CLI"
```

---
