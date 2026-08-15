### Task 1: Durable bus foundation and strict schemas

**Files:**

- Create: `tools/agents/lib/errors.mjs`
- Create: `tools/agents/lib/paths.mjs`
- Create: `tools/agents/lib/atomic-json.mjs`
- Create: `tools/agents/lib/schema.mjs`
- Create: `tests/tools/agent_comms/helpers.mjs`
- Create: `tests/tools/agent_comms/errors.test.mjs`
- Create: `tests/tools/agent_comms/paths.test.mjs`
- Create: `tests/tools/agent_comms/atomic-json.test.mjs`
- Create: `tests/tools/agent_comms/schema.test.mjs`

**Interfaces:**

- Produces `EXIT = Object.freeze({ OK: 0, USAGE: 2, TIMEOUT: 3, DATA: 4, CONFLICT: 5, REQUIRED: 6 })`.
- Produces `class CommsError extends Error { constructor(message, exitCode, details = null) }`.
- Produces `resolveBusDir({ cwd, env, runGit }) -> Promise<string>` and `createBusPaths(busDir) -> Readonly<object>`.
- Produces `ensureBusLayout(paths) -> Promise<void>`.
- Produces `readJsonStrict(filePath, validate)`, `writeJsonAtomic(filePath, value, { tmpDir, exclusive })`, `listJsonFiles(dirPath)`, and `moveFileAtomic(source, destination)`.
- Produces all `validate*` functions consumed by later modules; every validator returns the original value or throws `CommsError` with exit code `4`.
- Test helper exports are `createBusFixture()`, `createGitWorktreeFixture()`, `createFakeClock(startIso)`, `runCli(fixture, argv, options)`, `pathExists(path)`, `seedOpenAgent(context, input)`, `seedPresence(context, input)`, and `seedMessage(context, input)`. Small semantic builders such as `validMessage()` or `registration()` are declared locally in the test that uses them.

- [ ] **Step 1: Write discovery tests that prove main and linked worktrees converge**

```js
test("environment override wins", async () => {
  const bus = await resolveBusDir({
    cwd: fixture.root,
    env: { PW2_AGENT_BUS_DIR: fixture.bus },
    runGit: failIfCalled,
  });
  assert.equal(bus, fixture.bus);
});

test("main and linked worktree resolve one shared bus", async () => {
  assert.equal(await fixture.resolveFrom(fixture.main), fixture.bus);
  assert.equal(await fixture.resolveFrom(fixture.worktree), fixture.bus);
});

test("exit codes are stable", () => {
  assert.deepEqual(EXIT, { OK: 0, USAGE: 2, TIMEOUT: 3, DATA: 4, CONFLICT: 5, REQUIRED: 6 });
  assert.equal(new CommsError("bad data", EXIT.DATA).exitCode, 4);
});
```

- [ ] **Step 2: Run the discovery tests and capture the RED**

Run: `node --test tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs`

Expected: exit `1`, with `ERR_MODULE_NOT_FOUND` for `tools/agents/lib/paths.mjs`.

- [ ] **Step 3: Implement explicit override and conservative Git common-dir discovery**

```js
export async function resolveBusDir({ cwd, env = process.env, runGit }) {
  if (env.PW2_AGENT_BUS_DIR) return path.resolve(env.PW2_AGENT_BUS_DIR);
  const commonDir = path.resolve(cwd, (await runGit(cwd)).trim());
  if (path.basename(commonDir) !== ".git") {
    throw new CommsError("cannot infer checkout root; set PW2_AGENT_BUS_DIR", EXIT.DATA);
  }
  return path.join(path.dirname(commonDir), ".agents");
}
```

`createBusPaths()` must expose `protocol`, `registry`, `presence`, `inbox`, `seen`, `acknowledgements`, `claims`, `handoffs`, `archive`, `artifacts`, `locks`, `quarantine`, and `tmp`. `ensureBusLayout()` creates all directories and never deletes an existing record.

- [ ] **Step 4: Run discovery tests GREEN**

Run: `node --test tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs`

Expected: all path tests pass and exit `0`.

- [ ] **Step 5: Write atomic storage and schema tests**

```js
test("exclusive writes never replace an immutable record", async () => {
  await writeJsonAtomic(target, { value: 1 }, { tmpDir, exclusive: true });
  await assert.rejects(
    writeJsonAtomic(target, { value: 2 }, { tmpDir, exclusive: true }),
    error => error.exitCode === EXIT.CONFLICT,
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { value: 1 });
});

test("unknown message versions fail loudly", () => {
  assert.throws(
    () => validateMessage({ ...validMessage, schema_version: 2 }),
    error => error.exitCode === EXIT.DATA,
  );
});
```

Add cases for malformed JSON, invalid agent ids, every message/severity enum, absolute attachment paths, paths escaping the repository, invalid SHA-256, absent required fields, and wrong scalar/array types.

- [ ] **Step 6: Run storage/schema tests and capture the RED**

Run: `node --test tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs`

Expected: exit `1` because the storage and validation exports do not exist.

- [ ] **Step 7: Implement durable writes and strict validators**

`writeJsonAtomic()` must serialize once, open a unique file under `tmpDir` with flag `wx`, write the complete buffer, call `FileHandle.sync()`, and close it. Mutable records publish with same-filesystem rename. Immutable `exclusive` records publish with `fs.link(temp, destination)`, Node's atomic no-replace operation on the same filesystem, then unlink the temp name. This avoids both overwrite races and a visible empty/partial destination; a reader only opens the final `.json` path. Sync the destination directory after publication.

```js
export function validateAgentId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(value)) {
    throw new CommsError("invalid agent id", EXIT.DATA, { value });
  }
  return value;
}
```

Validators must reject unknown keys for protocol-owned records so misspelled fields cannot silently bypass a gate. Attachment validation accepts normalized repo-relative paths and normalized `.agents/artifacts` paths only.

- [ ] **Step 8: Demonstrate the corrupt-data gate and restore GREEN**

Create malformed JSON only inside the test fixture, run the atomic test, and retain the assertion that `readJsonStrict()` returns exit code `4`. Then run:

`node --test tests/tools/agent_comms/paths.test.mjs tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs`

Expected: all foundation tests pass and exit `0`.

- [ ] **Step 9: Commit the foundation**

```bash
git add tools/agents/lib/errors.mjs tools/agents/lib/paths.mjs tools/agents/lib/atomic-json.mjs tools/agents/lib/schema.mjs tests/tools/agent_comms/helpers.mjs tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs
git commit -m "feat: add durable agent bus foundation"
```

---
