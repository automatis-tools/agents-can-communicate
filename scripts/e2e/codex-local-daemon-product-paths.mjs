import { lstat, symlink } from "node:fs/promises";
import path from "node:path";
import { createMachine } from "./codex-local-daemon-machine.mjs";
import { attachSender, identify, launch, sendMessage, threadState, waitMarker }
  from "./codex-local-daemon-actions.mjs";
import { binding, settled } from "./codex-local-daemon-product-state.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";

export async function productPaths(h) {
  const child = await createMachine({ tarball: h.tarball, codex: h.codex, phase: "product",
    output: path.join(h.output, "uninstrumented-paths") });
  child.scenarios = [];
  let s;
  try {
    const alias = path.join(child.root, "receiver symlink");
    await symlink(child.B, alias);
    await launch(child, "receiver-b1", { cwd: alias, expectedCwd: child.B });
    const b = await identify(child, "receiver-b1"); await attachSender(child);
    s = scenario(child, "P20");
    s.equal(await lstat(path.join(child.B, ".git")).then(() => true, () => false), false);
    s.equal([b.actualCwd, (await threadState(child, b.threadId)).cwd], [child.B, child.B]);
    s.check(await binding(child));
    s.equal(child.generatedHook, undefined, "base uses the generated hook without our observer");
    const marker = path.join(child.B, "uninstrumented-marker.txt");
    const sent = await sendMessage(child, { id: "uninstrumented_base", marker });
    s.equal(sent.delivery[0].outcome, "offered");
    await waitMarker(child, "receiver-b1", marker, child.B); await settled(child, sent.message);
    s.check(child.cli.includes("prefix with spaces"), "installed skill CLI path contains spaces");
    s.fact("path", "observed"); s.fact("instrumentation", "absent");
    s.fact("binding", "matched", "receiver-b1", "receiver-b1"); s.fact("receipt", "acknowledged");
  } finally {
    const cleanup = await child.cleanup();
    if (cleanup.outcome !== "passed") throw new Error("uninstrumented child cleanup failed");
  }
  h.scenarios.push(s.finish());
}
