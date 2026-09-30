import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

const posixQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
// The model appends the header in whatever shell its client gives it, and on
// Windows that can be cmd.exe, which reads double quotes only. A value that a
// double-quoting shell would expand keeps single quotes, which PowerShell and
// Git Bash read literally - unless it holds a single quote too: sh reads '\''
// inside single quotes and PowerShell reads '', so the sh spelling leaves the
// rest of the value bare to PowerShell, where `$(...)` runs. No spelling reads
// the same in all three, and the value is refused rather than handed over.
//
// PowerShell also takes U+2018 to U+201B as single quotes and U+201C to U+201E
// as double quotes, and NTFS allows them in names: `x”;calc;”` in double quotes
// ends the string at `”`. cmd reads no single quotes at all, so a single-quoted
// value must carry nothing cmd acts on: & | < > ^, and % it expands anywhere.
const DOUBLE_QUOTES = /["\u201C-\u201E]/;
const SINGLE_QUOTES = /['\u2018-\u201B]/;
const CMD_ACTS_ON = /[&|<>^%]/;
const windowsQuote = value => {
  if (!DOUBLE_QUOTES.test(value) && !/[$`%]/.test(value)) return `"${value}"`;
  if (!SINGLE_QUOTES.test(value) && !CMD_ACTS_ON.test(value)) return `'${value}'`;
  throw new AccError(EXIT.USAGE, `${value} mixes quotes, $, \`, % or a cmd operator so that `
    + "no quoting reads it alike in cmd, PowerShell and Git Bash, and ACC's hooks will not hand "
    + "the model a command line it would read differently; rename the directory",
  { value, reasonCode: "workspace_path_unquotable" });
};

export const ownerHeader = (binding, cwd, workspaceRef, platform = process.platform) => {
  const quote = platform === "win32" ? windowsQuote : posixQuote;
  return "ACC CLI (append): --session "
    + assertPortableId(binding.accSessionId, "sessionId") + " --generation "
    + assertPortableId(binding.generation, "generation") + " --cwd " + quote(cwd)
    + (workspaceRef === undefined ? "" : " --workspace " + quote(workspaceRef));
};

export function ownerOnlyOutcome(inject, owner, budgetBytes) {
  if (Buffer.byteLength(owner, "utf8") > budgetBytes) {
    return { stdout: "", stderr: "acc: context budget cannot fit owner arguments; increase contextBudgetBytes" };
  }
  return { stdout: "", ...inject(owner) };
}

// This is ownership context only. No peer projection, receipt, new session or
// inherited environment belongs here. A client may deliver the line after the
// tool has closed its owner; owned CLI operations must still validate the pair.
export async function appendToolOwner(result, { event, binding, context, adapter }) {
  if (event.kind !== "beforeTool" || result.decision !== "allow" || binding === null
    || typeof adapter.injectToolOwnerOutcome !== "function") return result;
  const current = await context.service.locateSession(binding.accSessionId, context.descriptor.id);
  if (current?.record.state !== "open" || current.record.generation !== binding.generation) return result;

  const owner = ownerHeader(binding, context.workspaceCwd, context.workspaceRef);
  const injected = adapter.injectToolOwnerOutcome({ owner, tool: event.tool });
  if (injected === null) return result;
  const fitted = ownerOnlyOutcome(() => injected, owner,
    context.descriptor.policy?.contextBudgetBytes ?? 6_000);
  return { ...result, stdout: fitted.stdout,
    stderr: [result.stderr, fitted.stderr].filter(Boolean).join("\n") };
}

// SessionStart can also be a context reset. Return the binding just resumed by
// the hook; never require the model to remember it or attach another session.
export function appendStartOwner(result, { event, context, adapter }) {
  if (event.kind !== "sessionStart" || result.accSessionId === undefined
    || typeof adapter.injectStartOwnerOutcome !== "function") return result;
  return { ...result, ...ownerOnlyOutcome(text => adapter.injectStartOwnerOutcome(text),
    ownerHeader(result, context.workspaceCwd, context.workspaceRef),
    context.descriptor.policy?.contextBudgetBytes ?? 6_000) };
}
