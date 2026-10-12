// Interpreter and read-only entrypoint are baked by the installer. No prompts,
// transcript access, model turns, ACC writes or transport probes are needed.
const NODE = __ACC_NODE__;
const INDICATOR = __ACC_INDICATOR__;
// The reader answers at the latest 1.5 s after its modules load. Inside a loaded
// Claude the child's start alone took up to 1.3 s, so a shorter bound killed
// reads that would have answered and printed a false problem.
const READ_TIMEOUT_MS = 5000;
// A read that did not happen says nothing about this chat. Only a run of them
// replaces the last observed state.
const READ_FAILURES = ["indicator_unavailable", "state_unreadable"];
const FAILED_READS_SHOWN = 3;

let report = { label: "ACC …", health: "starting", detail: "Reading ACC state." };
let busy = false, sessionId = null, startedAt = 0, lastRead = 0, announced = null, failedReads = 0;

const failedRead = slow => ({ label: "ACC !", health: "problem", reasonCode: "indicator_unavailable",
  ...slow ? {
    detail: "The ACC indicator did not answer within five seconds.",
    action: "Run /acc-status to read it again; a busy machine can delay the answer.",
  } : {
    detail: "The ACC indicator could not read this session's state.",
    action: "Run acc install --adapter claude_code --indicator on, then /reload-plugins.",
  } });

async function refresh($) {
  if (busy) return;
  const id = await $.session.id();
  const now = await $.clock.now();
  if (id !== sessionId) {
    sessionId = id; startedAt = now; lastRead = 0; announced = null; failedReads = 0;
    report = { label: "ACC …", health: "starting", detail: "Reading ACC state." };
  }
  if (now - lastRead < (now - startedAt < 5000 ? 1000 : 5000)) return;
  lastRead = now; busy = true;
  let next;
  try {
    const value = await $.process.run([NODE, INDICATOR, "--adapter", "claude_code",
      "--native-session", id, "--json"], { timeoutMs: READ_TIMEOUT_MS });
    next = JSON.parse(value.stdout);
  } catch {
    next = failedRead(await $.clock.now() - now >= READ_TIMEOUT_MS);
  } finally { busy = false; }
  if (await $.session.id() !== id) return;
  failedReads = READ_FAILURES.includes(next.reasonCode) ? failedReads + 1 : 0;
  if (next.reasonCode === "not_registered" && now - startedAt < 5000) {
    report = { label: "ACC …", health: "starting",
      detail: "Waiting up to five seconds for the session hooks to register ACC." };
  } else if (failedReads === 0 || failedReads >= FAILED_READS_SHOWN) report = next;
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
    const color = report.health === "ready" ? "#2c7a39" : report.health === "problem" ? "warning" : "inactive";
    const qualifier = ["turn", "inbox"].includes(report.reception) ? ` · ${report.reception}` : "";
    // Native mode strings are all dimmed. Keep their rendering intact and put
    // only ACC's glyph in its own non-dim Text. Match Antigravity's ready green
    // exactly instead of allowing Claude's success theme color to desaturate it.
    return Box({ flexDirection: "row", children: [await next(e),
      Text({ color: "inactive", children: [" ACC "] }),
      Text({ color, bold: true, dimColor: false, children: [symbol] }),
      ...(qualifier ? [Text({ color: "inactive", children: [qualifier] })] : []),
    ] });
  });
}
