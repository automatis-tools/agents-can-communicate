import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Ported from the reconciled prototype without semantic change. Every managed
// path is validated segment by segment against the canonical root, so a
// symlinked ancestor cannot redirect a read or a publication - neither outside
// the store, nor to another directory inside it.
function invalidDirectory(message, directory, root, cause) {
  return new AccError(EXIT.DATA, message, {
    directory,
    root,
    ...(cause === undefined ? {} : { cause }),
  });
}

function relativeWithin(root, directory) {
  const relative = path.relative(root, directory);
  if (relative === "" || (!path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`))) return relative;
  throw invalidDirectory("managed directory escapes the store root", directory, root);
}

function absolutePath(value, name, root = value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw invalidDirectory(`${name} must be absolute`, value, root);
  }
  return path.normalize(value);
}

// How many more times a create-mode check takes a directory that left its name
// while being checked. The stage sweep renames `stage` aside and recreates it,
// without regard to a store that is still opening beside it, so one more try is
// the real case; the bound only stops a directory that never stays put from
// holding its caller (CI on #217).
const VANISHED_RETRIES = 4;

async function inspectRealDirectory(directory, root, create) {
  for (let attempt = 0; ; attempt += 1) {
    let details;
    try {
      details = await lstat(directory);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw invalidDirectory("cannot inspect managed directory", directory, root, error.message);
      }
      // Missing again right after it was created means a rename took it.
      if (!create || attempt > VANISHED_RETRIES) throw error;
      try {
        await mkdir(directory);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") {
          throw invalidDirectory("cannot create managed directory", directory, root,
            mkdirError.message);
        }
      }
      continue;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw invalidDirectory("managed directory is not a real directory", directory, root);
    }
    return details;
  }
}

async function inspectManagedDirectory(rootPath, directoryPath, create, { afterInspect } = {}) {
  const root = absolutePath(rootPath, "managed root");
  const directory = absolutePath(directoryPath, "managed directory", root);
  const relative = relativeWithin(root, directory);
  let details = await inspectRealDirectory(root, root, create);
  const canonicalRoot = await realpath(root);
  let current = root;
  // The canonical location of the directory validated so far. Every segment
  // has to be a child of it, which carries containment in the canonical root
  // down the whole walk by induction.
  let canonicalParent = canonicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let resolved;
    for (let attempt = 0; ; attempt += 1) {
      details = await inspectRealDirectory(current, root, create);
      await afterInspect?.(current);
      // A create-mode caller uses this name next. A directory renamed away
      // between the check and the resolution leaves realpath nothing to resolve
      // (ENOENT), so it is checked and created again, then resolved again; every
      // check below applies to whichever attempt settles.
      resolved = await resolveSegment(current, create && attempt < VANISHED_RETRIES);
      if (resolved !== null) break;
    }
    // realpath answers with the name the directory carries *now*, which is not
    // always the name that was asked for: on Darwin it resolves by opening the
    // path and asking the kernel for that vnode's current path, so a directory
    // renamed between those two steps comes back under its new name. Renaming
    // managed directories is ordinary here - the writer lock is granted,
    // reclaimed and released entirely by rename - so demanding the exact name
    // back reported an escape for an in-store move, intermittently and only
    // under load, and took real writes down with it.
    //
    // What a move cannot change is where the directory lives. An ancestor
    // replaced by a symlink after it was checked resolves somewhere else
    // entirely, so the parent is the thing to hold fixed: this segment must be
    // a child of the directory the previous one validated. Moving the leaf is
    // then the only disagreement left, and that one is settled by identity -
    // a moved directory is the same vnode under another name, while a sibling
    // swapped in under this name is not. ENOENT on the re-stat means it moved
    // again between the two calls, which cannot redirect anything: whatever
    // the caller opens through this path next fails the same way.
    if (path.dirname(resolved) !== canonicalParent
      || (path.basename(resolved) !== segment
        && !await stillTheSameDirectory(details, resolved, current, root))) {
      throw invalidDirectory("managed directory escapes the canonical store root", current, root);
    }
    canonicalParent = resolved;
  }
  return { directory, stat: details };
}

// null when the name went away and the caller may take it again.
async function resolveSegment(current, retry) {
  try {
    return await realpath(current);
  } catch (error) {
    if (error.code === "ENOENT" && retry) return null;
    throw error;
  }
}

async function stillTheSameDirectory(details, resolved, current, root) {
  const served = await stat(resolved).then(found => found, error => {
    if (error.code === "ENOENT") return null;
    throw invalidDirectory("cannot inspect managed directory", current, root, error.message);
  });
  return served === null || (served.dev === details.dev && served.ino === details.ino);
}

// `afterInspect` is the seam the race tests use: it runs between a segment's
// check and its resolution, the window a concurrent rename lands in.
export async function assertManagedDirectory(rootPath, directoryPath, options) {
  return inspectManagedDirectory(rootPath, directoryPath, false, options);
}

export async function ensureManagedDirectory(rootPath, directoryPath, options) {
  return (await inspectManagedDirectory(rootPath, directoryPath, true, options)).directory;
}
