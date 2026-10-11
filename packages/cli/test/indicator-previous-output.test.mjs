import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { previousOutput } from "../src/indicator-previous-command.mjs";

// A detached Windows cmd.exe loses standard handles even though a directly
// spawned Node process retains them. Exercise the real shell and pipe boundary.
for (const pipeline of [false, true]) {
  test(`a previous footer receives stdin through ${pipeline ? "a shell pipeline" : "the shell"}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "acc-footer-stdio-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = path.join(root, "copy.mjs");
    await writeFile(script, "let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(input);");
    const copy = `"${process.execPath}" "${script}"`;
    const command = pipeline ? `${copy} | ${copy}` : copy;
    const input = '{"session":"native-session","text":"вітаю ●"}';
    assert.equal(await previousOutput({ command }, input, 3000), input);
  });
}
