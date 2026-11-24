import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { powershellCandidates } from "./process-table.mjs";

// Who besides the user can write a path on Windows. Node reports every file
// there as mode 0o666 and every directory as 0o777, so the POSIX "group or
// others can write" test answers yes for every path (#445). Windows keeps that
// answer in the path's access control list instead.

const execFileAsync = promisify(execFile);
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";

// WriteData/CreateFiles, AppendData/CreateDirectories, WriteExtendedAttributes,
// DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership,
// GENERIC_ALL and GENERIC_WRITE: each lets its holder change what the path
// holds or who may. WriteAttributes alone (0x100) changes timestamps and flags.
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

/**
 * The principals other than `userSid`, SYSTEM and Administrators that can write
 * the path one access control list describes: an allow rule with a write right
 * that applies to the path itself, or an owner, who can always rewrite the list.
 * Deny rules are not subtracted, so the answer can only be stricter than
 * Windows. An unreadable list, or an unknown user, is one writer: "unreadable".
 */
export function otherWindowsWriters(acl, userSid) {
  if (acl === null || acl === undefined || typeof userSid !== "string") return ["unreadable"];
  const trusted = new Set([userSid, SYSTEM, ADMINISTRATORS]);
  const writers = new Set();
  if (!trusted.has(acl.owner)) writers.add(String(acl.owner));
  for (const rule of acl.rules ?? []) {
    if (rule?.type !== "Allow" || rule.inheritOnly === true) continue;
    if (((Number(rule.rights) >>> 0) & WRITE_RIGHTS) !== 0 && !trusted.has(rule.sid)) writers.add(String(rule.sid));
  }
  return [...writers];
}

// Paths arrive in an environment variable, so no path is ever part of the
// script. Rights print as signed 32-bit numbers; the caller reads them unsigned.
const SCRIPT = `$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.SecurityIdentifier]
$account = [System.Security.Principal.NTAccount]
function Name($id) { try { $id.Translate($account).Value } catch { $null } }
$out = @()
foreach ($p in @(ConvertFrom-Json $env:ACC_ACL_PATHS)) {
  try {
    $acl = Get-Acl -LiteralPath $p
    $rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; name = Name $_.IdentityReference; rights = [int64]$_.FileSystemRights.value__
         type = $_.AccessControlType.ToString()
         inheritOnly = (($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) } })
    $owner = $acl.GetOwner($sid)
    $out += @{ path = $p; owner = $owner.Value; ownerName = Name $owner; rules = $rules }
  } catch { $out += @{ path = $p; error = $_.Exception.Message } }
}
@{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; paths = $out } | ConvertTo-Json -Depth 6 -Compress`;

const list = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/**
 * Read the access control lists of `paths` and the current user's SID in one
 * PowerShell run. PowerShell 7 first, then Windows PowerShell, each by absolute
 * path. The caller's PSModulePath is dropped: a Windows PowerShell started from
 * PowerShell 7 inherits a module path from which it cannot load Get-Acl.
 * A path that cannot be read maps to null; no shell at all gives a null user.
 */
/** A principal as a person reads it: its account name with the SID, or the SID. */
export function windowsPrincipal(acl, sid) {
  const name = acl?.owner === sid && acl.ownerName ? acl.ownerName
    : (acl?.rules ?? []).find(rule => rule?.sid === sid && typeof rule.name === "string")?.name;
  return name ? `${name} (${sid})` : sid;
}

export async function readWindowsAcls(paths, { run = execFileAsync, env = process.env, timeoutMs = 15_000 } = {}) {
  const acls = new Map(paths.map(file => [file, null]));
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  childEnv.ACC_ACL_PATHS = JSON.stringify(paths);
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  const deadline = Date.now() + timeoutMs;
  for (const shell of powershellCandidates(env)) {
    if (Date.now() >= deadline) break;
    let parsed;
    try {
      const { stdout } = await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encoded], { env: childEnv, timeout: Math.max(1, deadline - Date.now()),
        killSignal: "SIGKILL", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      parsed = JSON.parse(String(stdout));
    } catch {
      continue; // Not installed, failed or unreadable: the next shell.
    }
    for (const entry of list(parsed?.paths)) {
      if (!acls.has(entry?.path) || typeof entry.owner !== "string") continue;
      acls.set(entry.path, { owner: entry.owner, ownerName: entry.ownerName ?? null, rules: list(entry.rules) });
    }
    return { user: typeof parsed?.user === "string" ? parsed.user : null, acls };
  }
  return { user: null, acls };
}
