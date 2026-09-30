// A command run the way a client runs it on this host. POSIX clients run an
// installed hook command through sh. On Windows each client picked its own
// shell (docs/design/2026-09-30-native-windows-support.md, "Client hook
// shells"), and a model's shell tool is Git Bash, PowerShell or cmd.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { resolveExecutable } from "@agents-can-communicate/adapter-sdk";

const windows = process.platform === "win32";

/** Windows PowerShell 5.1, which every Windows has. */
export const windowsPowerShell = (env = process.env) => path.win32.join(
  env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0",
  "powershell.exe");

/** Git Bash, found as Claude Code finds it: beside the git on PATH. */
export async function gitBash() {
  const git = await resolveExecutable("git");
  if (git === null) return null;
  // <Git>\cmd\git.exe, <Git>\bin\git.exe or <Git>\mingw64\bin\git.exe.
  for (const up of [[".."], ["..", ".."]]) {
    const candidate = path.resolve(path.dirname(git), ...up, "bin", "bash.exe");
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

// What Go's syscall.EscapeArg makes of one argument: Antigravity CLI starts
// `cmd /c <command>` through os/exec, which joins its arguments this way.
function goEscapeArg(value) {
  if (value === "") return '""';
  if (!/[\s"\\]/.test(value)) return value;
  const spaced = /[ \t]/.test(value);
  let out = spaced ? '"' : "";
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") { slashes += 1; out += char; continue; }
    if (char === '"') { out += "\\".repeat(slashes + 1) + char; slashes = 0; continue; }
    slashes = 0;
    out += char;
  }
  return spaced ? `${out}${"\\".repeat(slashes)}"` : out;
}

/**
 * The program and arguments that run `command` in `shell`:
 *   sh          /bin/sh -c (every POSIX client)
 *   bash        Git Bash -c (Claude Code's shell form and its model's Bash tool)
 *   powershell  Windows PowerShell -NoProfile -Command (Gemini CLI)
 *   pwsh        PowerShell 7 when on PATH, else Windows PowerShell (Codex, Grok)
 *   cmd         cmd.exe /d /s /c "<command>" - Node's `shell: true` (Kimi Code)
 *   go-cmd      cmd /c with Go's quoting (Antigravity CLI)
 *   exec        no shell: `command` is the program, `args` its arguments
 *               (Claude Code's exec form)
 */
export async function shellInvocation(shell, command, args = []) {
  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  switch (shell) {
    case "sh": return { file: "/bin/sh", args: ["-c", command], options: {} };
    case "bash": {
      const bash = await gitBash();
      if (bash === null) throw new Error("no Git Bash beside the git on PATH");
      return { file: bash, args: ["-c", command], options: {} };
    }
    case "powershell":
      return { file: windowsPowerShell(), args: ["-NoProfile", "-NonInteractive", "-Command", command],
        options: {} };
    case "pwsh":
      return { file: await resolveExecutable("pwsh") ?? windowsPowerShell(),
        args: ["-NoProfile", "-NonInteractive", "-Command", command], options: {} };
    case "cmd":
      return { file: comspec, args: ["/d", "/s", "/c", `"${command}"`],
        options: { windowsVerbatimArguments: true } };
    case "go-cmd":
      return { file: comspec, args: ["/c", goEscapeArg(command)],
        options: { windowsVerbatimArguments: true } };
    case "exec": return { file: command, args, options: {} };
    default: throw new Error(`unknown shell ${shell}`);
  }
}

/**
 * Run `command` in `shell` with `input` on stdin. Resolves `{ stdout, stderr }`
 * on exit 0 and rejects otherwise, with stdout and stderr on the error, as a
 * promisified execFile does.
 */
export async function runInShell(shell, command, { args = [], cwd, env = process.env,
  input = "" } = {}) {
  const invocation = await shellInvocation(shell, command, args);
  return new Promise((resolve, reject) => {
    const child = execFile(invocation.file, invocation.args,
      { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...invocation.options },
      (error, stdout, stderr) => (error === null ? resolve({ stdout, stderr })
        : reject(Object.assign(error, { stdout, stderr }))));
    child.stdin.end(input);
  });
}

/**
 * The shells a model's own shell tool runs on this host. `ref(name)` is an
 * environment variable as one argument; `call(words)` starts the program the
 * first word names, which PowerShell needs `&` for when that word is quoted or
 * a variable.
 */
export async function modelShells() {
  const posix = { ref: name => `"$${name}"`, call: words => words.join(" ") };
  if (!windows) return [{ shell: "sh", ...posix }];
  const shells = [];
  if (await gitBash() !== null) shells.push({ shell: "bash", ...posix });
  shells.push({ shell: "powershell", ref: name => `$env:${name}`,
    call: words => `& ${words.join(" ")}` });
  shells.push({ shell: "cmd", ref: name => `"%${name}%"`, call: words => words.join(" ") });
  return shells;
}
