// Discovery-only Node preload. Ignore prefix/tool-manager helpers; never change
// npm execution or exit semantics. The parent validates the bounded result.
import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const output = process.env.ACC_PUSH_NPM_PROBE;
if (output && process.argv[1]) {
  try {
    const cli = realpathSync(process.argv[1]);
    for (let directory = path.dirname(cli);;) {
      const manifest = path.join(directory, "package.json");
      try {
        if (statSync(manifest).size <= 65536) {
          const pkg = JSON.parse(readFileSync(manifest, "utf8"));
          const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.npm;
          if (pkg.name === "npm" && typeof bin === "string"
            && realpathSync(path.resolve(directory, bin)) === cli && statSync(cli).isFile()) {
            const node = realpathSync(process.execPath);
            if (statSync(node).isFile() && statSync(output).size <= 65536) {
              appendFileSync(output, `${JSON.stringify({ schema: 1, node, cli })}\n`);
            }
            break;
          }
        }
      } catch { /* A helper or missing package metadata is not npm's bin. */ }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* Unsupported discovery produces no record; npm still runs normally. */ }
}
