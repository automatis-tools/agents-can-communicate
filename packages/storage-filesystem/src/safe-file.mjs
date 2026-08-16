import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { assertManagedDirectory } from "./safe-directory.mjs";

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// O_NOFOLLOW plus a before/after identity check on the parent: the bytes
// returned come from the handle that was opened, not from whatever the path
// resolves to afterwards. The injected opener is the seam the crash-window and
// race tests use, and stays the final argument.
export async function readRegularNoFollow(filePath, root, openFile = open) {
  const parent = path.dirname(filePath);
  const before = await assertManagedDirectory(root, parent);
  let handle;
  try {
    handle = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    return await handle.readFile();
  } catch (error) {
    if (error instanceof AccError || error.code === "ENOENT") throw error;
    throw new AccError(EXIT.DATA, "cannot safely read regular file",
      { filePath, cause: error.message });
  } finally {
    await handle.close();
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
