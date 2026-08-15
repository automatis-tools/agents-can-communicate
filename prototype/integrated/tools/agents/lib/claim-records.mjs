import { createHash } from "node:crypto";
import path from "node:path";

import { listJsonFiles, readJsonStrict } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { validateClaim } from "./schema.mjs";

export function claimFilePath(context, scope) {
  const digest = createHash("sha256").update(scope).digest("hex");
  return path.join(context.paths.claims, `${digest}.json`);
}

export async function inspectClaimRecords(context) {
  const records = [], corrupt = [];
  for (const file of await listJsonFiles(context.paths.claims)) {
    try { records.push({ file, record: await readJsonStrict(file, validateClaim) }); }
    catch { corrupt.push(file); }
  }
  const counts = new Map();
  for (const item of records) counts.set(item.record.scope,
    (counts.get(item.record.scope) ?? 0) + 1);
  const valid = [];
  for (const item of records) {
    if (item.file !== claimFilePath(context, item.record.scope)
      || counts.get(item.record.scope) > 1) corrupt.push(item.file);
    else valid.push(item);
  }
  return { records: valid, corrupt: [...new Set(corrupt)].sort() };
}

export async function requireValidClaimRecords(context) {
  const result = await inspectClaimRecords(context);
  if (result.corrupt.length > 0) throw new CommsError("invalid claim store", EXIT.DATA,
    { paths: result.corrupt });
  return result.records;
}
