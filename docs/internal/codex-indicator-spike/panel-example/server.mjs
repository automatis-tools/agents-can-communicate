import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resourceUri = 'ui://acc/panel';
const schema = { type: 'object', properties: {}, additionalProperties: false };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const tools = [
  { name: 'acc_panel', title: 'ACC status', description: 'Open a read-only ACC status panel for this conversation.',
    inputSchema: schema, annotations,
    _meta: { ui: { resourceUri, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } } },
  { name: 'acc_status', title: 'Refresh ACC status', description: 'Read ACC status for the host-bound conversation.',
    inputSchema: schema, annotations, _meta: { ui: { visibility: ['app'] } } },
];

export function hostThreadId(meta) {
  if (!meta || Array.isArray(meta) || typeof meta !== 'object' || !uuid.test(meta.threadId ?? '')) {
    throw new Error('HOST_THREAD_ID_REQUIRED');
  }
  return meta.threadId;
}

export async function readStatus(threadId) {
  const node = process.env.ACC_PANEL_NODE;
  const reader = process.env.ACC_PANEL_READER;
  if (!node || !reader || !process.env.ACC_DATA_HOME) throw new Error('READER_NOT_CONFIGURED');
  let stdout;
  try {
    ({ stdout } = await execute(node, [reader, '--adapter', 'codex', '--native-session', threadId, '--json'], {
      env: process.env, timeout: 4000, maxBuffer: 32768,
    }));
  } catch (error) {
    if (!error.stdout) throw new Error('READER_UNAVAILABLE');
    stdout = error.stdout;
  }
  const status = JSON.parse(stdout);
  if (!['ready', 'problem'].includes(status.health)) throw new Error('INVALID_READER_RESULT');
  return { binding: { source: 'host-meta', threadId }, status };
}

export async function dispatch(method, params = {}, reader = readStatus) {
  if (method === 'initialize') return {
    protocolVersion: params.protocolVersion === '2024-11-05' ? '2024-11-05' : '2025-11-25',
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: 'acc-panel-spike', version: '0.0.1' },
  };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method === 'resources/list') return { resources: [{ uri: resourceUri, name: 'ACC panel', mimeType: 'text/html;profile=mcp-app' }] };
  if (method === 'resources/templates/list') return { resourceTemplates: [] };
  if (method === 'resources/read' && params.uri === resourceUri) return { contents: [{
    uri: resourceUri, mimeType: 'text/html;profile=mcp-app',
    text: await readFile(new URL('./panel.html', import.meta.url), 'utf8'),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] };
  if (method === 'tools/call' && tools.some(tool => tool.name === params.name)) {
    try {
      const boundThread = hostThreadId(params._meta);
      return { content: [], structuredContent: await reader(boundThread), isError: false };
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }
  throw Object.assign(new Error('Method or resource not found'), { code: -32601 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    try {
      const result = await dispatch(request.method, request.params);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: error.code ?? -32603, message: error.message } }) + '\n');
    }
  }
}
