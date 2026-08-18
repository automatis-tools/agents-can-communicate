import { realpath } from "node:fs/promises";
import path from "node:path";

import { normaliseResource } from "@agents-can-communicate/protocol";

/**
 * The spelling the filesystem itself uses.
 *
 * `normaliseResource` settles `./`, `//` and `..`, which is all a string can
 * settle. Letter case it cannot: on the filesystem this project is certified on,
 * `src/Physics.mjs` and `src/physics.mjs` are the same file, and a claim on one
 * did not cover a write to the other. Measured - the claim was taken, `acc
 * status` said `protection guarded`, and the write went through.
 *
 * Asking the filesystem answers it on both kinds of machine at once, with no
 * case rule anywhere: macOS `realpath` returns the name as stored, so both
 * spellings arrive at the same resource, and on Linux they are genuinely two
 * files and stay two resources. The guard canonicalises its targets the same
 * way, so the two sides meet.
 *
 * The path usually does not exist yet - claiming before creating is the point -
 * so the deepest existing ancestor is resolved and the rest appended.
 */
async function onDisk(absolute) {
  let current = absolute;
  const trailing = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...trailing);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return absolute;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

const GLOB = "/**";

/**
 * A `file:` claim, spelled the way the project spells it. Anything the
 * filesystem cannot answer for - another scheme, a path outside the workspace -
 * comes back as it went in rather than being invented into something else.
 */
export async function canonicalClaim(resource, descriptor) {
  const normalised = normaliseResource(resource);
  if (typeof normalised !== "string" || !normalised.startsWith("file:")) return normalised;
  const root = descriptor?.source === "git" && descriptor.git !== undefined
    ? descriptor.git.worktreeRoot
    : descriptor?.roots?.[0];
  if (typeof root !== "string") return normalised;

  const rest = normalised.slice("file:".length);
  const glob = rest.endsWith(GLOB);
  const body = glob ? rest.slice(0, -GLOB.length) : rest;
  if (body === "") return normalised;

  const resolved = await onDisk(path.resolve(root, body));
  const relative = path.relative(await onDisk(root), resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return normalised;
  }
  return `file:${relative.split(path.sep).join("/")}${glob ? GLOB : ""}`;
}
