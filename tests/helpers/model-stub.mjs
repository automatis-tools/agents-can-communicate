// A model endpoint on 127.0.0.1 that answers every turn with one short line.
// Real clients run against it with no account and no network, so their real
// hooks fire through ACC in CI. It speaks the Anthropic Messages API (Claude
// Code) and the OpenAI Responses API (Codex), and it keeps every request body,
// which is how a test sees what reached the model.
import { createServer } from "node:http";

const sse = (response, events) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache",
    connection: "keep-alive" });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
};

function anthropic(body, response, reply) {
  const usage = { input_tokens: 10, output_tokens: 1 };
  const message = { id: "msg_stub", type: "message", role: "assistant", model: body.model ?? "stub",
    content: [], stop_reason: null, stop_sequence: null, usage };
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...message, content: [{ type: "text", text: reply }],
      stop_reason: "end_turn" }));
    return;
  }
  sse(response, [
    ["message_start", { type: "message_start", message }],
    ["content_block_start", { type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: reply } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function responses(body, response, reply, sequence) {
  const id = `resp_stub_${sequence}`;
  const item = { type: "message", id: `msg_stub_${sequence}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: reply, annotations: [] }] };
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 };
  sse(response, [
    ["response.created", { type: "response.created", response: { id, object: "response",
      status: "in_progress", output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0,
      item: { ...item, status: "in_progress", content: [] } }],
    ["response.output_text.delta", { type: "response.output_text.delta", item_id: item.id,
      output_index: 0, content_index: 0, delta: reply }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
    ["response.completed", { type: "response.completed", response: { id, object: "response",
      status: "completed", output: [item], usage } }],
  ]);
}

/** Start the stub. `requests` grows with every call the clients make. */
export async function startModelStub({ reply = "ok" } = {}) {
  const requests = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    let body = null;
    try { body = text === "" ? null : JSON.parse(text); } catch { body = null; }
    requests.push({ method: request.method, url: request.url, body });
    const url = new URL(request.url, "http://stub");
    if (request.method === "POST" && url.pathname.endsWith("/messages/count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 10 }));
    } else if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      anthropic(body ?? {}, response, reply);
    } else if (request.method === "POST" && url.pathname.endsWith("/responses")) {
      sequence += 1;
      responses(body ?? {}, response, reply, sequence);
    } else if (request.method === "GET" && url.pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [] }));
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "not_found", message: request.url } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // A live client keeps its connections open, and close() alone would wait for
  // them for as long as the client lives.
  return { url: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

/** Every text a request carried to the model, flattened. */
export function promptText(request) {
  const parts = [];
  const walk = value => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(request.body);
  return parts.join("\n");
}
