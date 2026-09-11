import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Ported from the reconciled prototype without semantic change. Every managed
// path is validated segment by segment against the canonical root, so a
// symlinked ancestor cannot redirect a read or a publication outside the store.
function invalidDirectory(message, directory, root, cause) {
  return new AccError(EXIT.DATA, message, {
    directory,
    root,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isWithin(root, directory) {
  const relative = path.relative(root, directory);
  return !path.isAbsolute(relative) && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function relativeWithin(root, directory) {
  const relative = path.relative(root, directory);
  if (relative === "" || isWithin(root, directory)) return relative;
  throw invalidDirectory("managed directory escapes the store root", directory, root);
}

function absolutePath(value, name, root = value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw invalidDirectory(`${name} must be absolute`, value, root);
  }
  return path.normalize(value);
}

async function inspectRealDirectory(directory, root, create) {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT" && !create) throw error;
    if (error.code !== "ENOENT") {
      throw invalidDirectory("cannot inspect managed directory", directory, root, error.message);
    }
    try {
      await mkdir(directory);
    } catch (mkdirError) {
      if (mkdirError.code !== "EEXIST") {
        throw invalidDirectory("cannot create managed directory", directory, root,
          mkdirError.message);
      }
    }
    details = await lstat(directory);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw invalidDirectory("managed directory is not a real directory", directory, root);
  }
  return details;
}

async function inspectManagedDirectory(rootPath, directoryPath, create) {
  const root = absolutePath(rootPath, "managed root");
  const directory = absolutePath(directoryPath, "managed directory", root);
  const relative = relativeWithin(root, directory);
  let details = await inspectRealDirectory(root, root, create);
  const canonicalRoot = await realpath(root);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    details = await inspectRealDirectory(current, root, create);
    // realpath answers with the name the directory carries *now*, which is not
    // always the name that was asked for: on Darwin it resolves by opening the
    // path and asking the kernel for that vnode's current path, so a directory
    // renamed between those two steps comes back under its new name. Renaming
    // managed directories is ordinary here - the writer lock is granted,
    // reclaimed and released entirely by rename - so demanding the exact name
    // back reported an escape for an in-store move, intermittently and only
    // under load. What this check exists for, and all it exists for, is the
    // property stated at the top of this file: a symlinked ancestor must not
    // redirect a read or a publication outside the store. Judge that -
    // containment in the canonical root - rather than the name, which the
    // store itself changes.
    const resolved = await realpath(current);
    if (resolved === canonicalRoot || !isWithin(canonicalRoot, resolved)) {
      throw invalidDirectory("managed directory escapes the canonical store root", current, root);
    }
  }
  return { directory, stat: details };
}

export async function assertManagedDirectory(rootPath, directoryPath) {
  return inspectManagedDirectory(rootPath, directoryPath, false);
}

export async function ensureManagedDirectory(rootPath, directoryPath) {
  return (await inspectManagedDirectory(rootPath, directoryPath, true)).directory;
}
