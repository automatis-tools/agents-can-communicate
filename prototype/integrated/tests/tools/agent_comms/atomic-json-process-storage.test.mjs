import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  listJsonFiles,
  readJsonStrict,
  writeJsonAtomic,
} from "../../../tools/agents/lib/atomic-json.mjs";
import { createBusFixture } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

test("independent reader and writer processes never observe partial JSON",
  { timeout: 60_000 }, async t => {
    const fixture = await createBusFixture();
    t.after(fixture.cleanup);
    const target = fixture.paths.presenceFile("models");
    await writeJsonAtomic(target, { sequence: 0, lane: "A", payload: "A".repeat(65_536) }, {
      tmpDir: fixture.paths.tmp,
      exclusive: false,
    });
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      "../../../tools/agents/lib/atomic-json.mjs");
    const moduleUrl = pathToFileURL(modulePath).href;
    const common = `
      const atomic = await import(${JSON.stringify(moduleUrl)});
      const target = ${JSON.stringify(target)};
      const tmpDir = ${JSON.stringify(fixture.paths.tmp)};
      const root = ${JSON.stringify(fixture.paths.root)};
    `;
    const writer = `${common}
      for (let sequence = 1; sequence <= 150; sequence += 1) {
        const lane = sequence % 2 === 0 ? "A" : "B";
        await atomic.writeJsonAtomic(target,
          { sequence, lane, payload: lane.repeat(65536) }, { tmpDir, exclusive: false });
      }
    `;
    const reader = `${common}
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        await atomic.readJsonStrict(target, value => {
          if (!Number.isSafeInteger(value.sequence) || !["A", "B"].includes(value.lane)
            || value.payload !== value.lane.repeat(65536)) throw new Error("partial record");
          return value;
        }, root);
      }
    `;

    await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "--eval", writer]),
      ...Array.from({ length: 4 }, () =>
        execFileAsync(process.execPath, ["--input-type=module", "--eval", reader])),
    ]);

    const final = await readJsonStrict(target, value => value, fixture.paths.root);
    assert.equal(final.sequence, 150);
    assert.equal(final.payload, "A".repeat(65_536));
    assert.deepEqual(await listJsonFiles(fixture.paths.tmp, { root: fixture.paths.root }), []);
  });
