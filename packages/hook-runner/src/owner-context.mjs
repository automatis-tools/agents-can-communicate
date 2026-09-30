import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

const posixQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
// The model appends the header in whatever shell its client gives it, and on
// Windows that can be cmd.exe, PowerShell or Git Bash. Double quotes are the one
// quoting all three read alike, for a value with none of what one of them acts
// on inside double quotes: a double quote - PowerShell also ends a string at
// U+201C to U+201E, which NTFS allows in names - $ and a backtick, which
// PowerShell and bash expand, and %, which cmd expands. Single quotes are no
// answer: cmd takes them as part of the path. Such a value is refused rather
// than handed to a model that would read it as something else.
const DOUBLE_QUOTE_BREAKERS = /["\u201C-\u201E$`%]/;
const windowsQuote = value => {
  if (!DOUBLE_QUOTE_BREAKERS.test(value)) return `"${value}"`;
  throw new AccError(EXIT.USAGE, `${value} has a double quote, $, \` or % in it, which no quoting `
    + "reads alike in cmd, PowerShell and Git Bash, and ACC's hooks will not hand the model a "
    + "command line it would read differently; rename the directory",
  { value, reasonCode: "workspace_path_unquotable" });
};

// Before anything opens: a session that attached and could then never be told
// its CLI arguments would look live to its peers, and every one of its turns
// would fail before their messages reached it.
export function assertOwnerQuotable(cwd, workspaceRef, platform = process.platform) {
  if (platform !== "win32") return;
  windowsQuote(cwd);
  if (workspaceRef !== undefined) windowsQuote(workspaceRef);
}

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
