import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const provider = path.resolve("scripts/codex-indicator/provider.mjs");
const thread = "01a128bb-ff60-7bf3-90f6-6ab1337de377";
async function fixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "acc-codex-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reader = path.join(root, "reader.mjs");
  await writeFile(reader, source);
  return { root, reader };
}
function run(reader, input = { thread_id: thread, cwd: "/tmp" }) {
  const child = exec(process.execPath, [provider, reader], { timeout: 2000 });
  child.child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  return child.then(({ stdout }) => JSON.parse(stdout));
}

test("the bridge reads the exact native ID and colors only the successful glyph", async t => {
  const f = await fixture(t, `import { writeFileSync } from 'node:fs';
    writeFileSync(new URL('./args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({health:'ready',reception:'automatic'}));`);
  assert.deepEqual(await run(f.reader), { spans: [
    { text: "ACC " }, { text: "●", foreground: [44, 122, 57], bold: true },
  ] });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, "args.json"))),
    ["--adapter", "codex", "--native-session", thread, "--json"]);
});

test("fallback reception is visible and observed failures include the recovery command", async t => {
  for (const [health, reception, expected] of [
    ["ready", "turn", "ACC ● · turn"], ["ready", "inbox", "ACC ● · inbox"],
    ["problem", "turn", "ACC ! · turn · acc doctor"],
  ]) {
    const f = await fixture(t, `console.log(${JSON.stringify(JSON.stringify({ health, reception }))});`);
    const { spans } = await run(f.reader);
    assert.equal(spans.map(span => span.text).join(""), expected);
    assert.ok(spans.filter(span => span.foreground).every(span => ["●", "!"].includes(span.text)));
    assert.ok(spans.every(span => !Object.hasOwn(span, "background")));
  }
});

test("invalid identity fails closed before invoking the reader", async t => {
  const f = await fixture(t, `import { writeFileSync } from 'node:fs';
    writeFileSync(new URL('./called', import.meta.url), 'yes');`);
  for (const input of ['{', {}, { session_id: thread }, { thread_id: "bad\nidentity" }, "x".repeat(9000)]) {
    const { spans } = await run(f.reader, input);
    assert.equal(spans.map(span => span.text).join(""), "ACC ! · acc doctor");
  }
  await assert.rejects(readFile(path.join(f.root, "called")), { code: "ENOENT" });
});

test("reader failures, malformed output, and hanging readers never become green", async t => {
  for (const source of ["process.exit(1)", "console.log('invalid')", "setTimeout(()=>{},10000)",
    `console.log(JSON.stringify({health:'ready',reception:'invented'}))`,
    `console.log('x'.repeat(9000))`]) {
    const f = await fixture(t, source);
    const { spans } = await run(f.reader);
    assert.equal(spans.map(span => span.text).join(""), "ACC ! · acc doctor");
  }
});
