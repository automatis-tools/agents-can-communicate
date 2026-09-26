// What ACC 0.7.x wrote for a `claude` live install: a PATH block in ~/.zshrc
// and a shim in an ACC-owned directory. The product no longer creates either;
// tests use this verbatim copy of the 0.7.x creation code to lay out the state
// a current install and update must retire.
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { BLOCK_BEGIN, BLOCK_END, SHIM_MARKER, locateBlock }
  from "../../packages/installer/src/shell-bootstrap.mjs";

export { BLOCK_BEGIN, BLOCK_END, SHIM_MARKER };

const usage = (message, details = {}) => { throw new AccError(EXIT.USAGE, message, details); };
const sha256 = text => createHash("sha256").update(text).digest("hex");
const COMMAND_NAME = /^[a-z][a-z0-9_.-]*$/;
export const shellLiteral = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const isAbsolute = value => typeof value === "string" && path.isAbsolute(value);
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const defaultIo = Object.freeze({ readFile, writeFile, mkdir, chmod, rename, rm, rmdir, readdir });

async function readText(io, file) {
  try {
    return await io.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(io, file, content, mode) {
  const temporary = `${file}.${process.pid}.tmp`;
  await io.writeFile(temporary, content, { mode });
  await io.rename(temporary, file);
  await io.chmod(file, mode);
}

export function renderPathBlock(shimDir) {
  return `${BLOCK_BEGIN}\nexport PATH=${shellLiteral(shimDir)}:"$PATH"\n${BLOCK_END}\n`;
}

export const SUPPORTED_SHELLS = Object.freeze(["zsh"]);
export const SHIM_POLICIES = Object.freeze(["actionable", "all"]);

export function validateShimEntry(entry) {
  if (entry === null || typeof entry !== "object") usage("a shim entry must be an object");
  for (const key of Object.keys(entry)) {
    if (!["adapterId", "command", "realExecutable", "prefixArgs", "livePolicy"].includes(key)) {
      usage(`unknown shim entry field ${key}`, { key });
    }
  }
  assertPortableId(entry.adapterId, "shim adapter id");
  if (typeof entry.command !== "string" || !COMMAND_NAME.test(entry.command)) {
    usage("a shim command must be a bare command name", { command: entry.command });
  }
  if (!isAbsolute(entry.realExecutable)) usage("a shim realExecutable must be an absolute path");
  if (!Array.isArray(entry.prefixArgs) || entry.prefixArgs.some(arg => typeof arg !== "string"
    || arg === "" || /[\0\n]/.test(arg))) {
    usage("shim prefixArgs must be non-empty argument strings without NUL or newline");
  }
  if (!SHIM_POLICIES.includes(entry.livePolicy)) {
    usage("a shim livePolicy must be actionable or all; off means no shim", { livePolicy: entry.livePolicy });
  }
  return Object.freeze({ ...entry, prefixArgs: Object.freeze([...entry.prefixArgs]) });
}

export function renderCommandShim({ node, bootstrap, dataHome, entry }) {
  const shim = validateShimEntry(entry);
  for (const [name, value] of Object.entries({ node, bootstrap, dataHome })) {
    if (!isAbsolute(value)) usage(`shim ${name} must be an absolute path`, { [name]: value });
  }
  const real = shellLiteral(shim.realExecutable);
  const check = [node, bootstrap, "--adapter", shim.adapterId, "--real-executable",
    shim.realExecutable, "--data-home", dataHome].map(shellLiteral).join(" ");
  const prefix = shim.prefixArgs.map(shellLiteral).join(" ");
  return [
    "#!/bin/sh",
    `${SHIM_MARKER} for ${shellLiteral(shim.command)}. Generated; do not edit.`,
    "# ACC_BYPASS=1 runs the vendor command untouched. A failed or missing check",
    "# does the same: the vendor command is never blocked on ACC.",
    'if [ "${ACC_BYPASS-}" = "1" ]; then',
    "  unset ACC_NATIVE_DELIVERY_POLICY",
    `  exec ${real} "$@"`,
    "fi",
    `if ${check} </dev/null >/dev/null 2>&1; then`,
    `  ACC_NATIVE_DELIVERY_POLICY=${shellLiteral(shim.livePolicy)}`,
    "  export ACC_NATIVE_DELIVERY_POLICY",
    `  exec ${real}${prefix === "" ? "" : ` ${prefix}`} "$@"`,
    "fi",
    "unset ACC_NATIVE_DELIVERY_POLICY",
    `exec ${real} "$@"`,
    "",
  ].join("\n");
}

export function planShellBootstrap({ shell, rcFile, shimDir, entries = [], runtime = null }) {
  if (!SUPPORTED_SHELLS.includes(shell)) {
    return Object.freeze({ eligible: false, reasonCode: "unsupported_shell", shell: shell ?? null,
      rcFile: null, shimDir: null, block: null, shims: Object.freeze([]), runtime: null });
  }
  if (!isAbsolute(rcFile) || !isAbsolute(shimDir)) usage("rcFile and shimDir must be absolute");
  const validated = entries.map(validateShimEntry);
  const commands = new Set();
  for (const entry of validated) {
    if (commands.has(entry.command)) usage(`duplicate shim command ${entry.command}`);
    commands.add(entry.command);
    // A shim that resolved to itself would loop forever; the real executable
    // is resolved before the shim directory is ever on PATH.
    if (inside(shimDir, entry.realExecutable)) {
      usage("a shim realExecutable cannot live inside the shim directory",
        { realExecutable: entry.realExecutable });
    }
  }
  return Object.freeze({ eligible: true, reasonCode: null, shell, rcFile, shimDir,
    block: renderPathBlock(shimDir), runtime,
    shims: Object.freeze(validated.map(entry => Object.freeze({
      path: path.join(shimDir, entry.command), entry }))) });
}

export async function installShellBootstrap({ plan, io = defaultIo }) {
  if (!plan?.eligible) return { ok: false, reasonCode: plan?.reasonCode ?? "unsupported_shell" };
  const { node, bootstrap, dataHome } = plan.runtime ?? {};
  const current = await readText(io, plan.rcFile);
  const span = locateBlock(current);
  const existing = span === null ? null : current.slice(span.start, span.end);
  if (existing !== null && existing !== plan.block) {
    return { ok: false, reasonCode: "rc_block_modified", rcFile: plan.rcFile };
  }
  await io.mkdir(plan.shimDir, { recursive: true, mode: 0o700 });
  await io.chmod(plan.shimDir, 0o700);
  const shims = [];
  for (const shim of plan.shims) {
    const content = renderCommandShim({ node, bootstrap, dataHome, entry: shim.entry });
    await writeAtomic(io, shim.path, content, 0o700);
    shims.push({ path: shim.path, command: shim.entry.command, sha256: sha256(content) });
  }
  let appended = false;
  if (existing === null) {
    const base = current ?? "";
    const separator = base === "" || base.endsWith("\n") ? "" : "\n";
    await writeAtomic(io, plan.rcFile, `${base}${separator}${plan.block}`, 0o600);
    appended = true;
  }
  return { ok: true, reasonCode: null, shell: plan.shell, shimDir: plan.shimDir,
    rcFile: { path: plan.rcFile, blockSha256: sha256(plan.block), appended },
    shims };
}


/**
 * Lay out a 0.7.x shell activation and return the mechanism record it wrote,
 * in the shape `installs.json` carries it.
 */
export async function writeLegacyShellActivation({ adapterId, command, realExecutable, prefixArgs = [],
  livePolicy = "actionable", shimDir, rcFile, node = process.execPath,
  bootstrap = "/tmp/unused-bootstrap.mjs", dataHome }) {
  const plan = planShellBootstrap({ shell: "zsh", rcFile, shimDir,
    runtime: { node, bootstrap, dataHome },
    entries: [{ adapterId, command, realExecutable, prefixArgs, livePolicy }] });
  const result = await installShellBootstrap({ plan });
  if (!result.ok) throw new Error(`legacy shell bootstrap refused: ${result.reasonCode}`);
  return { kind: "shell-bootstrap", command, shimDir,
    ownedFiles: result.shims.map(shim => ({ path: shim.path, sha256: shim.sha256 })),
    rcFile: result.rcFile };
}
