import { assertPortableId } from "@agents-can-communicate/protocol";

export const ownerHeader = binding => "ACC CLI (append): --session "
  + assertPortableId(binding.accSessionId, "sessionId") + " --generation "
  + assertPortableId(binding.generation, "generation");

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

  const owner = ownerHeader(binding);
  const injected = adapter.injectToolOwnerOutcome({ owner, tool: event.tool });
  if (injected === null) return result;
  const fitted = ownerOnlyOutcome(() => injected, owner,
    context.descriptor.policy?.contextBudgetBytes ?? 6_000);
  return { ...result, stdout: fitted.stdout,
    stderr: [result.stderr, fitted.stderr].filter(Boolean).join("\n") };
}
