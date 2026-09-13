// Invoked only after adapter configuration and ownership/consent persistence.
// A failed service command must not erase the successful adapter operation.
export async function applyServiceSetup({ adapter, context, operation, results }) {
  const plan = operation.nativeServiceSetup;
  if (!plan || operation.livePolicy === "off" || operation.deliveryDecision?.completeSetup !== true) return;
  let setup = plan;
  if (["needed", "ready"].includes(plan.state)) {
    try {
      setup = await adapter.prepareNativeServiceSetup({ context, plan,
        installPrerequisites: operation.deliveryDecision.installPrerequisites === true });
      if (!setup || !["ready", "failed", "blocked"].includes(setup.state)) throw new Error("invalid setup result");
    } catch {
      setup = { state: "failed", started: false, reasonCode: "service_setup_failed",
        diagnostic: `${adapter.displayName} service preparation failed; check the vendor service and retry acc install` };
    }
  }
  operation.nativeServiceSetup = setup;
  if (setup.state === "ready") {
    const stale = new Set([operation.deliverySummary, operation.deliveryDiagnostic, plan.diagnostic]);
    operation.summary = (operation.summary ?? []).filter(line => !stale.has(line));
    operation.summary.push(setup.diagnostic);
    operation.diagnostics = (operation.diagnostics ?? []).filter(line => !stale.has(line));
    operation.deliverySummary = setup.diagnostic;
    operation.deliveryDiagnostic = setup.diagnostic;
  } else {
    operation.needsAction.push(setup.diagnostic);
    if (setup.state === "failed") results.failed.push({ adapterId: operation.adapterId,
      error: setup.diagnostic, reasonCode: setup.reasonCode });
  }
  operation.diagnostics.push(setup.diagnostic);
}
