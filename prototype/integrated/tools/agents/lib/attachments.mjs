import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { CommsError, EXIT } from "./errors.mjs";
import { validateAttachment } from "./schema.mjs";

const EMPTY_SHA256 = "0".repeat(64);
const ARTIFACT_PREFIX = ".agents/artifacts/";

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."
    && !path.isAbsolute(relative));
}

function assertWithin(candidate, root, displayPath) {
  if (isWithin(candidate, root)) return;
  throw new CommsError("attachment resolves outside its allowed root", EXIT.DATA, {
    path: displayPath,
  });
}

function validateInput(input) {
  return validateAttachment({
    path: input.path,
    sha256: EMPTY_SHA256,
    size: 0,
    ephemeral: input.ephemeral,
    ...(input.commit === undefined ? {} : { commit: input.commit }),
  });
}

function sourcePath(context, record) {
  if (record.ephemeral) {
    const suffix = record.path.slice(ARTIFACT_PREFIX.length);
    return path.join(context.paths.artifacts, suffix);
  }
  return path.join(context.repoRoot ?? path.dirname(context.paths.root), record.path);
}

async function digestFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function inspectAttachment(context, input) {
  const validated = validateInput(input);
  const allowedRoot = validated.ephemeral
    ? context.paths.artifacts
    : context.repoRoot ?? path.dirname(context.paths.root);
  try {
    const [canonicalRoot, canonicalFile, canonicalArtifacts] = await Promise.all([
      realpath(allowedRoot),
      realpath(sourcePath(context, validated)),
      realpath(context.paths.artifacts),
    ]);
    assertWithin(canonicalFile, canonicalRoot, validated.path);
    if (!validated.ephemeral && isWithin(canonicalFile, canonicalArtifacts)) {
      throw new CommsError("artifact attachment must be ephemeral", EXIT.DATA, {
        path: validated.path,
      });
    }
    const metadata = await stat(canonicalFile);
    if (!metadata.isFile()) {
      throw new CommsError("attachment must be a regular file", EXIT.DATA, {
        path: validated.path,
      });
    }
    const sha256 = await digestFile(canonicalFile);
    return { validated, sha256, size: metadata.size };
  } catch (error) {
    if (error instanceof CommsError) throw error;
    throw new CommsError("cannot read attachment", EXIT.DATA, {
      path: validated.path,
      cause: error.message,
    });
  }
}

export async function describeAttachment(context, input) {
  const { validated, sha256, size } = await inspectAttachment(context, input);
  return validateAttachment({
    ...validated,
    sha256,
    size,
  });
}

export async function verifyAttachment(context, record) {
  const validated = validateAttachment(record);
  const actual = await inspectAttachment(context, validated);
  if (actual.sha256 !== validated.sha256 || actual.size !== validated.size) {
    throw new CommsError("attachment evidence does not match file", EXIT.DATA, {
      path: validated.path,
      expectedSha256: validated.sha256,
      actualSha256: actual.sha256,
      expectedSize: validated.size,
      actualSize: actual.size,
    });
  }
}
