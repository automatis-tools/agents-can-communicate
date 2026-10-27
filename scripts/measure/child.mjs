// One side of one round (#304): build the fixture with the side's own code,
// validate every call, time the calls after warm-up, observe one more, and
// print one JSON line. Validation never runs inside a timed call.
import { performance } from "node:perf_hooks";

const { probe: name, root, scenario, samples, warmup, mutation } = JSON.parse(process.argv[2]);
const probe = (await import(new URL(`./probes/${name}.mjs`, import.meta.url))).default;
const side = await probe.load(root);
const built = await probe.build(scenario, side);
const failures = [];
const note = list => { for (const failure of list) if (failures.length < 20 && !failures.includes(failure)) failures.push(failure); };
try {
  const mutations = mutation ? (probe.mutationsFor?.(scenario) ?? probe.mutations) : null;
  if (mutation && !mutations?.[mutation]) throw new Error(`${name} has no mutation ${mutation}`);
  const operate = mutation ? await mutations[mutation](probe.operate, { side, scenario }) : probe.operate;
  for (let call = 0; call < warmup; call++) note(await probe.validate(built, await operate(built)));
  const samplesNs = [];
  for (let call = 0; call < samples; call++) {
    const started = performance.now();
    const result = await operate(built);
    samplesNs.push(Math.round((performance.now() - started) * 1e6));
    note(await probe.validate(built, result));
  }
  const { failures: observed = [], ...observations } = await probe.observe(built);
  note(observed);
  process.stdout.write(`${JSON.stringify({ fixtureDigest: built.digest, validation: failures, samplesNs, observations })}\n`);
} finally { await probe.dispose(built); }
