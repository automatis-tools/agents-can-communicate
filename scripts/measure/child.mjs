// One side of one round (#304): build the fixture with the side's own code, then
// for every call prepare its input, time the call alone, and validate it. One
// more call is observed. The result is one JSON line on stdout; a failure still
// prints what was gathered, with the error that ended it.
import { performance } from "node:perf_hooks";

const { probe: name, root, scenario, samples, warmup, mutation } = JSON.parse(process.argv[2]);
const failures = [], samplesNs = [];
const note = list => { for (const failure of list) if (failures.length < 20 && !failures.includes(failure)) failures.push(failure); };
let probe, built, observations = {}, error;
try {
  probe = (await import(new URL(`./probes/${name}.mjs`, import.meta.url))).default;
  const side = await probe.load(root);
  const mutations = probe.mutationsFor(scenario);
  if (mutation && !mutations[mutation]) throw new Error(`${name} has no mutation ${mutation}`);
  const operate = mutation ? await mutations[mutation](probe.operate, { side, scenario }) : probe.operate;
  built = await probe.build(scenario, side);
  const call = async () => {
    const input = await probe.prepare?.(built);
    const started = performance.now();
    const result = await operate(built, input);
    const elapsed = performance.now() - started;
    note(await probe.validate(built, result, input));
    return elapsed;
  };
  for (let index = 0; index < warmup; index++) await call();
  for (let index = 0; index < samples; index++) samplesNs.push(Math.round((await call()) * 1e6));
  const { failures: observed = [], ...rest } = await probe.observe(built);
  note(observed);
  observations = rest;
} catch (caught) {
  error = caught?.stack ?? String(caught);
} finally {
  if (built !== undefined) await probe.dispose(built).catch(() => {});
}
process.stdout.write(`${JSON.stringify({ fixtureDigest: built?.digest ?? null, validation: failures, samplesNs,
  observations, ...(error === undefined ? {} : { error }) })}\n`);
if (error !== undefined) process.exitCode = 1;
