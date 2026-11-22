// What the agents' tests share: a caller and a message as values, a clock the test moves, and the two stand-ins
// the Strands agents need, each on loopback on a port the system picks and each labelled below. Nothing here
// mints a token or imports another piece's code.

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

import type { Caller } from '../../shared/access-token.ts';
import type { InboundMessage } from '../../shared/agent-contract.ts';
import type { ModelSettings } from '../src/model/served.ts';

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The server has no port');
  return `http://127.0.0.1:${address.port}`;
}

export function stop(server: Server): void {
  server.close();
  server.closeAllConnections();
}

export function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

// Who a run is for, as a front door hands it to the handler once the token was accepted.
export const CALLER: Caller = {
  subject: 'subject-of-the-test-caller',
  username: 'dana.desk',
  name: 'Dana Desk',
  clientId: 'desk',
  roles: ['default-roles-lab'],
  scopes: ['agents:intake'],
  expiresAt: new Date('2026-03-01T10:10:00.000Z'),
  token: 'token-of-the-test-caller-never-to-be-repeated',
};

export function message(id: string, text: string): InboundMessage {
  return { id, received_at: '2026-03-01T08:55:00.000Z', sender: 'dr.lee@clinic.example', text };
}

// Moves one millisecond each time it is read, so the run's deadline is never reached by reading alone, and the
// test can move it on.
export type Clock = { now: () => Date; advance: (ms: number) => void };

export function clock(): Clock {
  let at = new Date('2026-03-01T10:00:00.000Z').getTime();
  return { now: () => new Date(at++), advance: (ms) => (at += ms) };
}

// --- Stand-in 1: the scripted model server --------------------------------------------------------------------
// STAND-IN for the model server. NOT a model. It answers POST /v1/responses (Strands' default API) with a stream
// of events in the shape the real server sends, and POST /v1/chat/completions with one JSON body. Each answer
// comes from the test's script, given what the request carried and how many requests of the same conversation
// came before it, so two runs at once each get their own script.

export type ModelAnswer =
  | { kind: 'text'; content: string }
  | { kind: 'tools'; calls: Array<{ name: string; arguments: string }> }
  | { kind: 'status'; status: number };

export const say = (content: string): ModelAnswer => ({ kind: 'text', content });
export const ask = (...calls: Array<[name: string, args: unknown]>): ModelAnswer => ({
  kind: 'tools',
  calls: calls.map(([name, args]) => ({ name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })),
});

// A request to the model, read the same way from either API.
export type ModelRequest = { user: string; outputs: Array<{ callId: string; output: string }>; tools: string[]; body: string };

export type ScriptedModel = { settings: ModelSettings; requests: ModelRequest[] };

function readModelRequest(text: string): ModelRequest {
  const body: unknown = JSON.parse(text);
  const read: ModelRequest = { user: '', outputs: [], tools: [], body: text };
  const tools = prop(body, 'tools');
  if (Array.isArray(tools)) read.tools = tools.map((tool) => String(prop(tool, 'name') ?? prop(prop(tool, 'function'), 'name')));
  const items = prop(body, 'input') ?? prop(body, 'messages');
  for (const item of Array.isArray(items) ? items : []) {
    const content = prop(item, 'content');
    if (prop(item, 'role') === 'user') {
      read.user += Array.isArray(content) ? content.map((part) => String(prop(part, 'text'))).join('') : String(content);
    } else if (prop(item, 'type') === 'function_call_output') {
      read.outputs.push({ callId: String(prop(item, 'call_id')), output: String(prop(item, 'output')) });
    } else if (prop(item, 'role') === 'tool') {
      read.outputs.push({ callId: String(prop(item, 'tool_call_id')), output: String(content) });
    }
  }
  return read;
}

export async function startModel(t: TestContext, script: (request: ModelRequest, nth: number) => ModelAnswer): Promise<ScriptedModel> {
  const requests: ModelRequest[] = [];
  const seen = new Map<string, number>();
  let callIds = 0;

  function chat(response: ServerResponse, answer: Exclude<ModelAnswer, { kind: 'status' }>): void {
    const tool_calls =
      answer.kind === 'tools' ? answer.calls.map((c) => ({ id: `call-${++callIds}`, type: 'function', function: c })) : undefined;
    sendJson(response, 200, {
      choices: [{ finish_reason: tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: answer.kind === 'text' ? answer.content : null, tool_calls } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }

  function stream(response: ServerResponse, answer: Exclude<ModelAnswer, { kind: 'status' }>): void {
    const about = { id: 'resp-scripted', object: 'response', model: 'scripted', incomplete_details: null };
    const output: unknown[] = [];
    const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { ...about, status: 'in_progress', output: [] } }];
    if (answer.kind === 'text') {
      const id = 'msg-scripted';
      const part = { type: 'output_text', text: answer.content, annotations: [] };
      const done = { id, type: 'message', role: 'assistant', status: 'completed', content: [part] };
      events.push(
        { type: 'response.output_item.added', output_index: 0, item: { ...done, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
        { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: answer.content },
        { type: 'response.output_text.done', item_id: id, output_index: 0, content_index: 0, text: answer.content },
        { type: 'response.content_part.done', item_id: id, output_index: 0, content_index: 0, part },
        { type: 'response.output_item.done', output_index: 0, item: done },
      );
      output.push(done);
    } else {
      answer.calls.forEach((c, index) => {
        const callId = `call-${++callIds}`;
        const id = `fc-${callId}`;
        const done = { id, type: 'function_call', call_id: callId, name: c.name, arguments: c.arguments, status: 'completed' };
        events.push(
          { type: 'response.output_item.added', output_index: index, item: { ...done, arguments: '', status: 'in_progress' } },
          { type: 'response.function_call_arguments.delta', item_id: id, output_index: index, delta: c.arguments },
          { type: 'response.function_call_arguments.done', item_id: id, output_index: index, arguments: c.arguments, name: c.name },
          { type: 'response.output_item.done', output_index: index, item: done },
        );
        output.push(done);
      });
    }
    events.push({ type: 'response.completed', response: { ...about, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    events.forEach((event, n) => response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: n })}\n\n`));
    response.end();
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://model').pathname;
    bodyText(request)
      .then((text) => {
        const read = readModelRequest(text);
        requests.push(read);
        const nth = seen.get(read.user) ?? 0;
        seen.set(read.user, nth + 1);
        const answer = script(read, nth);
        if (answer.kind === 'status') sendJson(response, answer.status, { error: 'scripted status' });
        else if (path === '/v1/responses') stream(response, answer);
        else chat(response, answer);
      })
      .catch(() => response.destroy());
  });
  const url = await listen(server);
  t.after(() => stop(server));
  return { settings: { baseUrl: `${url}/v1`, apiKey: 'key-of-the-model-server', modelId: 'scripted', temperature: 0, maxTokens: 256, seed: 1 }, requests };
}

// --- Stand-in 2: the scripted MCP server ----------------------------------------------------------------------
// STAND-IN for the case system or the retrieval service. NOT either. It offers the tools the test names and
// answers each call as the test's script says, or drops it: the call is received, and the connection is closed
// with no answer. It records every request with its headers, and every tool call.

export type ToolAnswer = CallToolResult | 'drop';
export type ScriptedTool = { shape: ZodRawShape; answer: (args: Record<string, unknown>, nth: number) => ToolAnswer };
export type McpStandIn = {
  url: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  requests: Array<{ headers: IncomingHttpHeaders; body: string }>;
};

export function result(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

export async function startMcp(t: TestContext, tools: Record<string, ScriptedTool>): Promise<McpStandIn> {
  const stand: Omit<McpStandIn, 'url'> = { calls: [], requests: [] };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const text = await bodyText(request);
    stand.requests.push({ headers: request.headers, body: text });
    const body: unknown = JSON.parse(text);
    let answer: CallToolResult | undefined;
    if (prop(body, 'method') === 'tools/call') {
      const name = String(prop(prop(body, 'params'), 'name'));
      const given = prop(prop(body, 'params'), 'arguments');
      const args: Record<string, unknown> = typeof given === 'object' && given !== null ? { ...given } : {};
      const nth = stand.calls.filter((c) => c.tool === name).length;
      stand.calls.push({ tool: name, args });
      const scripted = tools[name]?.answer(args, nth);
      if (scripted === 'drop') {
        response.destroy();
        return;
      }
      answer = scripted;
    }
    const mcp = new McpServer({ name: 'scripted-stand-in', version: '1' });
    for (const [name, tool] of Object.entries(tools)) {
      mcp.registerTool(name, { description: `Stand-in ${name}.`, inputSchema: tool.shape }, () => answer ?? result({ error: 'not_scripted' }, true));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => response.destroy());
  });
  const url = await listen(server);
  t.after(() => stop(server));
  return { url: `${url}/mcp`, ...stand };
}
