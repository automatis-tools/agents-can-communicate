#!/usr/bin/env node
// Local, explicitly requested Codex build installation. Not part of acc install.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdir, readFile, readlink, rename, rmdir,
  symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const sha256 = data => createHash("sha256").update(data).digest("hex");
const hashFile = async file => sha256(await readFile(file));
const version = "codex-cli 0.162.1";
const ownedNames = ["codex", "provider.mjs", "install.mjs", "launcher", "uninstall"];
async function maybeRead(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}
async function linkTarget(file) {
  if (!(await lstat(file)).isSymbolicLink()) throw new Error("Codex command must be a symbolic link");
  return readlink(file);
}
async function replaceLink(file, target, expected) {
  if (await linkTarget(file).catch(() => null) !== expected) throw new Error("Codex command changed; preserving it");
  const temporary = `${file}.acc-${randomUUID()}`;
  try {
    await symlink(target, temporary);
    // Recheck immediately before publication; never replace a detected user edit.
    if (await linkTarget(file).catch(() => null) !== expected) throw new Error("Codex command changed; preserving it");
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function install(values) {
  for (const key of ["root", "binary", "command", "reader", "sha256"]) {
    if (!values[key]) throw new Error(`Missing --${key}`);
  }
  const root = path.resolve(values.root), binary = path.resolve(values.binary);
  const command = path.resolve(values.command), reader = path.resolve(values.reader);
  if (!/^[a-f0-9]{64}$/.test(values.sha256) || await hashFile(binary) !== values.sha256) {
    throw new Error("Binary checksum mismatch");
  }
  await access(reader, constants.R_OK);
  const { stdout } = await exec(binary, ["--version"], { timeout: 5000, maxBuffer: 4096 });
  if (stdout.trim() !== version) throw new Error(`Expected ${version}`);
  const previousLink = await linkTarget(command);
  const previous = await maybeRead(path.join(root, "installation.json"));
  if (previous) {
    const receipt = JSON.parse(previous);
    if (previousLink === receipt.launcher && receipt.binarySha256 === values.sha256
        && receipt.command === command && receipt.reader === reader) {
      for (const name of ownedNames) {
        if (await hashFile(path.join(root, name)) !== receipt.files[name]) {
          throw new Error("Installed files changed; preserving them");
        }
      }
      return receipt;
    }
    throw new Error("Installation already exists; uninstall it before replacing it");
  }
  await access(path.resolve(path.dirname(command), previousLink), constants.X_OK);
  const launcher = path.join(root, "launcher");
  const provider = path.join(root, "provider.mjs");
  const argv = JSON.stringify([process.execPath, provider, reader]);
  const fallback = JSON.stringify({ spans: [{ text: "ACC " },
    { text: "!", foreground: [150, 108, 30], bold: true }, { text: " · acc doctor" }] });
  const stock = path.resolve(path.dirname(command), previousLink);
  const originalVersion = await exec(stock, ["--version"], { timeout: 5000, maxBuffer: 4096 });
  if (originalVersion.stdout.trim() !== version) {
    throw new Error("Original Codex version changed; build a matching local version first");
  }
  // mkdir is an exclusive reservation. An occupied path is never reused or removed.
  await mkdir(root, { mode: 0o700 });
  const created = [];
  try {
    for (const [name, source] of [["codex", binary], ["provider.mjs", path.join(import.meta.dirname, "provider.mjs")],
      ["install.mjs", import.meta.filename]]) {
      await copyFile(source, path.join(root, name), constants.COPYFILE_EXCL);
      created.push(name);
    }
    await chmod(path.join(root, "codex"), 0o755);
    if (await hashFile(path.join(root, "codex")) !== values.sha256) throw new Error("Copied binary checksum mismatch");
    const scripts = {
      launcher: `#!/bin/sh\n# ACC local Codex 0.162.1 build; restore with the adjacent uninstall command.\n`
        + `export CODEX_STATUS_PROVIDER_ORIGINAL_CLI=${quote(stock)}\n`
        + `export CODEX_STATUS_PROVIDER=${quote(argv)}\nexport CODEX_STATUS_PROVIDER_FALLBACK=${quote(fallback)}\nexec ${quote(path.join(root, "codex"))} "$@"\n`,
      uninstall: `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "install.mjs"))} uninstall --root ${quote(root)}\n`,
    };
    for (const [name, content] of Object.entries(scripts)) {
      await writeFile(path.join(root, name), content, { mode: 0o755, flag: "wx" });
      created.push(name);
    }
    const files = Object.fromEntries(await Promise.all(ownedNames.map(async name => [name, await hashFile(path.join(root, name))])));
    const receipt = { schema: 1, version, installedAt: new Date().toISOString(),
      sourceCommit: "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d", binarySha256: values.sha256,
      command, previousLink, reader, launcher, files };
    await writeFile(path.join(root, "installation.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    created.push("installation.json");
    await replaceLink(command, launcher, previousLink);
    return receipt;
  } catch (error) {
    for (const name of created.reverse()) await unlink(path.join(root, name)).catch(() => {});
    await rmdir(root).catch(() => {});
    throw error;
  }
}
async function uninstall(root) {
  if (!root) throw new Error("Missing --root");
  root = path.resolve(root);
  const receipt = JSON.parse(await readFile(path.join(root, "installation.json"), "utf8"));
  if (receipt.schema !== 1 || receipt.launcher !== path.join(root, "launcher")
      || !path.isAbsolute(receipt.command) || typeof receipt.previousLink !== "string") {
    throw new Error("Invalid installation receipt");
  }
  await access(path.resolve(path.dirname(receipt.command), receipt.previousLink), constants.X_OK);
  await replaceLink(receipt.command, receipt.previousLink, receipt.launcher);
  const preserved = [];
  for (const name of ownedNames) {
    const file = path.join(root, name);
    try {
      if (await hashFile(file) === receipt.files[name]) await unlink(file);
      else preserved.push(file);
    } catch (error) { if (error.code !== "ENOENT") preserved.push(file); }
  }
  await unlink(path.join(root, "installation.json"));
  await rmdir(root).catch(error => { if (error.code !== "ENOTEMPTY") throw error; });
  return { restored: receipt.command, target: receipt.previousLink, preserved };
}
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    ["root", "binary", "sha256", "command", "reader"].map(key => [key, { type: "string" }])) });
  if (positionals.length !== 1 || !["install", "uninstall"].includes(positionals[0])) {
    throw new Error("Use install --binary PATH --sha256 HASH --command LINK --reader PATH --root PATH, or uninstall --root PATH");
  }
  const result = positionals[0] === "install" ? await install(values) : await uninstall(values.root);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
