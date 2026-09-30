// A hook command in the form each client's Windows hook runner reads. Measured
// from the clients' sources and binaries (docs/design/2026-09-30-native-windows-
// support.md): Codex and Gemini CLI run PowerShell, Grok detects PowerShell,
// Git Bash or cmd, Kimi Code runs cmd.exe, and Antigravity runs `cmd /c` through
// Go, which escapes inner quotes as `\"` - a form cmd does not read.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const defaultRun = promisify(execFile);

// Characters one of those shells expands or ends a quoted word on. A path that
// carries one is refused: writing it would run something other than the shim.
const EXPANDED = /[$`"%]/;

const powershellLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const forward = value => String(value).replaceAll("\\", "/");

/**
 * @param {"powershell"|"portable"|"cmd"|"unquoted"} shell
 * @param {{ node: string, shim: string, args: string[] }} parts
 */
export function windowsHookCommand(shell, { node, shim, args }) {
  for (const word of [node, shim]) {
    if (EXPANDED.test(word)) {
      throw new Error(`a hook command cannot name ${word}: a Windows shell would expand it`);
    }
  }
  const tail = args.join(" ");
  switch (shell) {
    // `&` runs a quoted program; single quotes take nothing literally but `''`.
    // pwsh -Command reports exit 2 as 1 unless the command exits itself.
    case "powershell":
      return `& ${powershellLiteral(node)} ${powershellLiteral(shim)} ${tail}; exit $LASTEXITCODE`;
    // Node from PATH, which every one of the three shells finds; the shim then
    // prefers the pinned runner. Forward slashes survive bash unquoting.
    case "portable":
      return `node "${forward(shim)}" ${tail}`;
    case "cmd":
      return `"${node}" "${shim}" ${tail}`;
    case "unquoted":
      if (/\s/.test(shim)) throw new Error(`a hook command cannot name ${shim} unquoted: it has a space`);
      return `node ${forward(shim)} ${tail}`;
    default:
      throw new Error(`unknown Windows hook shell: ${shell}`);
  }
}

/**
 * The 8.3 form of a path with a space in it, for a hook runner that cannot pass
 * a quoted path (Antigravity CLI). cmd prints it through `%~s`. A volume with 8.3
 * names turned off answers with the long path, which the caller then refuses.
 */
export async function shortPath(file, { run = defaultRun, env = process.env } = {}) {
  if (!/\s/.test(file)) return file;
  if (/["%^&|<>!]/.test(file)) return file;
  const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  const { stdout } = await run(comspec, ["/d", "/c", `for %I in ("${file}") do @echo %~sI`],
    { windowsHide: true, windowsVerbatimArguments: true, timeout: 5_000 });
  const answer = String(stdout).trim().split(/\r?\n/).at(-1) ?? "";
  return answer === "" ? file : answer;
}

