// Interpreter and read-only entrypoint are baked by the installer. No prompts,
// transcript access, model turns, ACC writes or transport probes are needed.
const NODE = __ACC_NODE__;
const INDICATOR = __ACC_INDICATOR__;

let report = { label: "ACC …", health: "starting", detail: "Reading ACC state." };
let busy = false, sessionId = null, startedAt = 0, lastRead = 0, announced = null;

async function refresh($) {
  if (busy) return;
  const id = await $.session.id();
  const now = await $.clock.now();
  if (id !== sessionId) {
    sessionId = id; startedAt = now; lastRead = 0; announced = null;
    report = { label: "ACC …", health: "starting", detail: "Reading ACC state." };
  }
  if (now - lastRead < (now - startedAt < 5000 ? 1000 : 5000)) return;
  lastRead = now; busy = true;
  try {
    const value = await $.process.run([NODE, INDICATOR, "--adapter", "claude_code",
      "--native-session", id, "--json"], { timeoutMs: 1200 });
    const next = JSON.parse(value.stdout);
    if (await $.session.id() !== id) return;
    if (next.reasonCode === "not_registered" && now - startedAt < 5000) {
      report = { label: "ACC …", health: "starting",
        detail: "Waiting up to five seconds for the session hooks to register ACC." };
    } else report = next;
  } catch {
    report = { label: "ACC !", health: "problem", reasonCode: "indicator_unavailable",
      detail: "The ACC indicator could not read this session's state.",
      action: "Run acc install --adapter claude_code --indicator on, then /reload-plugins." };
  } finally { busy = false; }
  if (report.health === "problem" && report.reasonCode !== announced) {
    await $.ui.log([report.detail, report.action, "Details: /acc-status"].filter(Boolean).join(" "));
    announced = report.reasonCode;
  } else if (report.health === "ready") announced = null;
  $.ui.invalidate("ui.render");
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    $.clock.every(1000, async () => { await refresh($); });
    await refresh($);
    await $.command.register({ name: "acc-status", immediate: true,
      description: "Explain this chat's ACC indicator and its next recovery step" });
    return next(e);
  });
  on("command.run", { command: "acc-status" }, async ($) => {
    lastRead = 0;
    await refresh($);
    return { text: [report.label, report.detail, report.action].filter(Boolean).join("\n") };
  });
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e);
    const symbol = report.health === "ready" ? "●" : report.health === "problem" ? "!" : "…";
    const color = report.health === "ready" ? "success" : report.health === "problem" ? "warning" : "inactive";
    const qualifier = ["turn", "inbox"].includes(report.reception) ? ` · ${report.reception}` : "";
    // Native mode strings are all dimmed. Keep their rendering intact and put
    // only ACC's glyph in its own non-dim Text, using the light/dark theme colors.
    return Box({ flexDirection: "row", children: [await next(e),
      Text({ color: "inactive", children: [" ACC "] }),
      Text({ color, bold: true, dimColor: false, children: [symbol] }),
      ...(qualifier ? [Text({ color: "inactive", children: [qualifier] })] : []),
    ] });
  });
}
