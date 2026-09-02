import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { assertManagedDirectory } from "./safe-directory.mjs";

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// The operation runs through the opened handle only after O_NOFOLLOW and the
// before/after parent identity check agree. Replacing the pathname after that
// point cannot redirect a read or append through the already-open descriptor.
export async function withRegularNoFollow(filePath, root, flags, operation, openFile = open) {
  const parent = path.dirname(filePath);
  const before = await assertManagedDirectory(root, parent);
  let handle;
  try {
    handle = await openFile(filePath, flags | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw new AccError(EXIT.DATA, "cannot safely open regular file",
      { filePath, cause: error.message });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new AccError(EXIT.DATA, "record is not a regular file", { filePath });
    }
    const after = await assertManagedDirectory(root, parent);
    if (!sameDirectory(before.stat, after.stat)) {
      throw new AccError(EXIT.DATA, "record parent directory changed while opening",
        { filePath, root });
    }
    return await operation(handle, stat);
  } catch (error) {
    if (error instanceof AccError || error.code === "ENOENT") throw error;
    throw new AccError(EXIT.DATA, "cannot safely access regular file",
      { filePath, cause: error.message });
  } finally {
    await handle.close();
  }
}

export async function readRegularNoFollow(filePath, root, openFile = open) {
  try {
    return await withRegularNoFollow(filePath, root, constants.O_RDONLY,
      handle => handle.readFile(), openFile);
  } catch (error) {
    if (error instanceof AccError || error.code === "ENOENT") throw error;
    throw new AccError(EXIT.DATA, "cannot safely read regular file",
      { filePath, cause: error.message });
  }
}

export async function readJsonNoFollow(filePath, root, openFile = open) {
  const bytes = await readRegularNoFollow(filePath, root, openFile);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch (error) {
    throw new AccError(EXIT.DATA, "invalid JSON record", { filePath, cause: error.message });
  }
}
