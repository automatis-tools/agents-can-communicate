// Measurement only: the flushes and renames of each traced hook, by purpose.
import { readFile } from "node:fs/promises";

const purpose = by => {
  for (const [pattern, label] of [
    [/prepareCandidate|withWriterMutex storage-filesystem\/src\/writer-mutex\.mjs:2[0-2]\d|releaseCanonical|writer-mutex\.mjs:39/, "writer lock"],
    [/hook-workspace/, "workspace registry"],
    [/requireStoreIdentity|initialiseActiveJournal|stage-sweep/, "store setup and sweep"],
    [/writeJournalEntry|appendTransition|completeJournal|retireJournalEntry/, "journal bookkeeping"],
    [/rollForward/, "journalled records"],
    [/store\.mjs:405/, "single record, no journal"],
    [/storeSessionBinding|session-binding/, "session binding"],
    [/native-attempt|storeNativeAttempt/, "native attempt"],
    [/pins?|writeRuntimePin/, "runtime pin"],
    [/inbox-endpoint|native-endpoint|relay-endpoint/, "live endpoint"],
  ]) if (pattern.test(by)) return label;
  return `other: ${by.split(" < ")[0]}`;
};
const hooks = (await readFile(process.argv[2] ?? "fsync-trace.log", "utf8")).split("\n").filter(Boolean)
  .map(line => JSON.parse(line));
const byHook = new Map();
for (const item of hooks) { const list = byHook.get(item.hook) ?? []; list.push(item); byHook.set(item.hook, list); }
for (const [label, list] of byHook) {
  const table = new Map();
  for (const item of list) for (const event of item.events) {
    const key = purpose(event.by);
    const row = table.get(key) ?? { flush: 0, rename: 0, ms: 0, max: 0 };
    if (event.op === "rename") row.rename += 1; else { row.flush += 1; row.ms += event.ms; row.max = Math.max(row.max, event.ms); }
    table.set(key, row);
  }
  const runs = list.length;
  const total = [...table.values()].reduce((sum, row) => sum + row.flush, 0) / runs;
  console.log(`\n=== ${label} (${runs} runs): ${total} flushes per hook`);
  for (const [key, row] of [...table].sort((a, b) => b[1].flush - a[1].flush)) {
    console.log(`  ${(row.flush / runs).toFixed(1).padStart(5)} flush  ${(row.rename / runs).toFixed(1).padStart(4)} rename  `
      + `${(row.ms / Math.max(1, row.flush)).toFixed(1).padStart(6)} ms avg  ${row.max.toFixed(1).padStart(6)} ms max  ${key}`);
  }
}
