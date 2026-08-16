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
    const expected = path.join(canonicalRoot, path.relative(root, current));
    if (await realpath(current) !== expected) {
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
