import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { CommsError, EXIT } from "./errors.mjs";
import { assertManagedDirectory } from "./safe-directory.mjs";

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function readRegularNoFollow(filePath, root, openFile = open) {
  const parent = path.dirname(filePath);
  const before = await assertManagedDirectory(root, parent);
  let handle;
  try {
    handle = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw new CommsError("cannot safely open regular file", EXIT.DATA,
      { filePath, cause: error.message });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CommsError("record is not a regular file", EXIT.DATA,
      { filePath });
    const after = await assertManagedDirectory(root, parent);
    if (!sameDirectory(before.stat, after.stat)) {
      throw new CommsError("record parent directory changed while opening", EXIT.DATA,
        { filePath, root });
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof CommsError || error.code === "ENOENT") throw error;
    throw new CommsError("cannot safely read regular file", EXIT.DATA,
      { filePath, cause: error.message });
  } finally {
    await handle.close();
  }
}

export async function readJsonRegularNoFollow(filePath, validate, root, openFile = open) {
  const bytes = await readRegularNoFollow(filePath, root, openFile);
  try { return { record: validate(JSON.parse(bytes.toString("utf8"))), bytes }; }
  catch (error) {
    if (error instanceof CommsError) throw error;
    throw new CommsError("invalid JSON record", EXIT.DATA,
      { filePath, cause: error.message });
  }
}
