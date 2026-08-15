import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { CommsError, EXIT } from "./errors.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function readJsonStrict(filePath, validate) {
  const source = await readFile(filePath, "utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CommsError("invalid JSON record", EXIT.DATA, {
      filePath,
      cause: error.message,
    });
  }

  try {
    return validate(value);
  } catch (error) {
    if (error instanceof CommsError) throw error;
    throw new CommsError("invalid JSON record", EXIT.DATA, {
      filePath,
      cause: error.message,
    });
  }
}

export async function writeJsonAtomic(
  filePath,
  value,
  { tmpDir, exclusive = false },
) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new CommsError("record is not JSON serializable", EXIT.DATA, { filePath });
  }
  const buffer = Buffer.from(`${serialized}\n`, "utf8");
  const destinationDir = path.dirname(filePath);
  await Promise.all([
    mkdir(tmpDir, { recursive: true }),
    mkdir(destinationDir, { recursive: true }),
  ]);
  const temporaryPath = path.join(
    tmpDir,
    `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlinkIfPresent(temporaryPath);
    throw error;
  }
  await handle.close();

  try {
    if (exclusive) {
      try {
        await link(temporaryPath, filePath);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new CommsError("immutable record already exists", EXIT.CONFLICT, {
            filePath,
          });
        }
        throw error;
      }
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, filePath);
    }
    await syncDirectory(destinationDir);
  } catch (error) {
    await unlinkIfPresent(temporaryPath);
    throw error;
  }
}

export async function listJsonFiles(dirPath) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function moveFileAtomic(source, destination) {
  const destinationDir = path.dirname(destination);
  await mkdir(destinationDir, { recursive: true });
  await rename(source, destination);
  await syncDirectory(destinationDir);
}
