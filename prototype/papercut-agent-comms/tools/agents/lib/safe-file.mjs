import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { CommsError, EXIT } from "./errors.mjs";

export async function readRegularNoFollow(filePath, openFile = open) {
  const handle = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CommsError("record is not a regular file", EXIT.DATA,
      { filePath });
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function readJsonRegularNoFollow(filePath, validate, openFile = open) {
  const bytes = await readRegularNoFollow(filePath, openFile);
  try { return { record: validate(JSON.parse(bytes.toString("utf8"))), bytes }; }
  catch (error) {
    if (error instanceof CommsError) throw error;
    throw new CommsError("invalid JSON record", EXIT.DATA,
      { filePath, cause: error.message });
  }
}
