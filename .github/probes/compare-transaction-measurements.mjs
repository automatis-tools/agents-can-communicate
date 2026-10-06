import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const evidence = path.resolve(process.argv[2]);
const old = JSON.parse(await readFile(path.join(evidence, "measurement-old.json")));
const candidate = JSON.parse(await readFile(path.join(evidence, "measurement-candidate.json")));
assert.equal(old.storeContract, 6);
assert.equal(candidate.storeContract, 7);
assert.equal(old.platform, "win32");
assert.equal(candidate.platform, old.platform);
assert.equal(candidate.node, old.node);
const expected = {20: 500, 40: 1800, 60: 3900};
for (const n of [20, 40, 60]) {
  assert.equal(old.totals[n].stateReads, expected[n]);
  assert.equal(candidate.totals[n].stateReads, n * 6);
  assert.equal(candidate.sends[n].stateReads, 6);
  assert.equal(candidate.sends[n].indexFlushes, 0);
}
for (const [operation, expected] of [["read", 2], ["offered", 3], ["ack", 4], ["failed", 3], ["cold", 2], ["retry", 7]]) {
  assert.equal(candidate[operation].stateReads, expected);
  assert.equal(candidate[operation].indexFlushes, 0);
}
const report = { platform: candidate.platform, node: candidate.node,
  old: old.totals, candidate: candidate.totals,
  lastSends: Object.fromEntries([20, 40, 60].map(n => [n, candidate.sends[n]])),
  receiptOperations: Object.fromEntries(["read", "offered", "ack", "failed", "cold", "retry"].map(op => [op, { old: old[op], candidate: candidate[op] }])) };
await writeFile(path.join(evidence, "comparison.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
