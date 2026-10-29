// A deterministic model fixture for the real Codex tool/approval loop.
// It tests routing and request contents, not an OpenAI model's judgment.
import { createServer } from "node:http";

export function reviewedAction(body) {
  const parts = body.input?.flatMap(item => item.content ?? []) ?? [];
  for (const part of [...parts].reverse()) {
    try {
      const value = JSON.parse(part.text);
      if (Array.isArray(value.command) && value.tool === "exec_command") return value;
    } catch { /* Other transcript sections are prose. */ }
  }
  return null;
}

export async function startCommandModel({ nextCall, review = () => false }) {
  const requests = [];
  const actions = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    if (!request.url.endsWith("/responses")) { response.writeHead(404).end(); return; }
    try {
      const body = JSON.parse(raw);
      requests.push(body);
      let item;
      if (body.model === "codex-auto-review") {
        const action = reviewedAction(body);
        actions.push(action);
        const allowed = review(action);
        item = message(JSON.stringify({ risk_level: allowed ? "low" : "high",
          user_authorization: allowed ? "medium" : "unknown", outcome: allowed ? "allow" : "deny",
          rationale: allowed ? "Fixture allows the described local action." : "Fixture rejects this action." }));
      } else {
        const outputs = (body.input ?? []).filter(item => item.type === "function_call_output");
        const call = nextCall(outputs);
        item = call === null ? message("fixture complete")
          : { type: "function_call", id: `fc_${sequence}`, call_id: `call_${sequence}`,
            name: "exec_command", arguments: JSON.stringify(call) };
      }
      const id = `resp_${++sequence}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [event, data] of [
        ["response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
        ["response.completed", { type: "response.completed", response: { id, status: "completed", output: [item],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }],
      ]) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, actions,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

function message(text) {
  return { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
}
