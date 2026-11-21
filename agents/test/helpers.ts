// What the agent's tests share: servers on loopback, clocks the tests control, the real case system
// in-process, and the only two test doubles (each labelled below): a scripted model and a
// reply-dropping proxy in front of the case system's MCP endpoint.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { TestContext } from 'node:test';

import { z } from 'zod';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse, Step } from '../../shared/agent-contract.ts';
import { createAgentServer, createReviewServer } from '../../tools/case-system/src/http.ts';
import { CaseStore } from '../../tools/case-system/src/store.ts';
import type { AgentIdentity } from '../src/contract/server.ts';
import { handleInquiry } from '../src/intake/handwritten.ts';
import type { IntakeDeps, Limits } from '../src/intake/handwritten.ts';
import { createChatModel } from '../src/model/chat.ts';
import type { ChatModel } from '../src/model/chat.ts';
import { connectCaseTools } from '../src/tools/case-system.ts';
import type { Connected } from '../src/tools/tool-set.ts';

// --- Servers on loopback ----------------------------------------------------------------------------

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

export function stop(server: Server): void {
  server.close();
  server.closeAllConnections();
}

// A URL that cannot be reached: it accepts each connection and closes it at once. Held until the test
// ends, so no other test is given its port in the meantime.
export async function deadUrl(t: TestContext): Promise<string> {
  const server = createNetServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseOrUndefined(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

// Reads a field of a JSON value the test does not otherwise need to type.
export function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entries: Record<string, unknown> = { ...value };
  return entries[key];
}

// --- Clocks -----------------------------------------------------------------------------------------

// Starts at a fixed instant and moves one second forward each time it is read.
export function steppingClock(start: string): () => Date {
  let seconds = 0;
  const base = new Date(start).getTime();
  return () => new Date(base + 1000 * seconds++);
}

// The agent's clock. It moves one millisecond each time it is read, so step times are ordered and
// the run's deadline is never reached by reading alone, and a test can jump it forward.
export type AgentClock = { now: () => Date; advance: (ms: number) => void };

export function agentClock(start: string): AgentClock {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at++),
    advance: (ms) => {
      at += ms;
    },
  };
}

// --- Test double 1: the scripted model -------------------------------------------------------------
// STAND-IN for the model server. NOT a model. An HTTP server that speaks the two routes of the
// OpenAI-compatible API the agent uses (GET /v1/models, POST /v1/chat/completions) and answers each
// chat request with the next answer from a queue the test wrote. It records every request body.
// When the queue is empty it answers 500 and counts the request as unexpected, so a test that ran
// past its script fails visibly instead of being handed a default answer.

export type ScriptedAnswer =
  | { kind: 'text'; content: string | null; finishReason: string }
  | { kind: 'tools'; calls: Array<{ name: string; arguments: string; id?: string }>; finishReason: string }
  | { kind: 'status'; status: number }
  | { kind: 'never' };

export type ScriptedModel = {
  baseUrl: string;
  model: ChatModel;
  // Every body received at /v1/chat/completions, parsed, in order.
  requests: unknown[];
  unexpectedRequests: () => number;
};

export const SCRIPTED_MODEL_ID = 'scripted-stand-in';

export type ScriptOptions = {
  // Answered for every request once the queue is empty, in place of the 500.
  whenEmpty?: ScriptedAnswer;
  // Called as each chat request arrives, before it is answered.
  onRequest?: (n: number) => void;
};

export function text(content: string | null, finishReason = 'stop'): ScriptedAnswer {
  return { kind: 'text', content, finishReason };
}

export function toolCalls(...calls: Array<{ name: string; arguments: string; id?: string }>): ScriptedAnswer {
  return { kind: 'tools', calls, finishReason: 'tool_calls' };
}

export function call(name: string, args: unknown): { name: string; arguments: string } {
  return { name, arguments: JSON.stringify(args) };
}

export async function startScriptedModel(
  t: TestContext,
  answers: ScriptedAnswer[],
  options: ScriptOptions = {},
): Promise<ScriptedModel> {
  const queue = [...answers];
  const requests: unknown[] = [];
  let unexpected = 0;
  let callIds = 0;

  function sendJson(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  }

  function answer(response: ServerResponse, next: ScriptedAnswer): void {
    switch (next.kind) {
      case 'never':
        return;
      case 'status':
        sendJson(response, next.status, { error: 'scripted status' });
        return;
      case 'text':
        sendJson(response, 200, {
          choices: [{ finish_reason: next.finishReason, message: { role: 'assistant', content: next.content } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
        return;
      case 'tools':
        sendJson(response, 200, {
          choices: [
            {
              finish_reason: next.finishReason,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: next.calls.map((c) => ({
                  id: c.id ?? `call-${++callIds}`,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
        return;
    }
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://model').pathname;
    if (path === '/v1/models' && request.method === 'GET') {
      sendJson(response, 200, { data: [{ id: SCRIPTED_MODEL_ID }] });
      return;
    }
    if (path !== '/v1/chat/completions' || request.method !== 'POST') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    bodyText(request)
      .then((body) => {
        requests.push(parseOrUndefined(body));
        options.onRequest?.(requests.length);
        const next = queue.shift() ?? options.whenEmpty;
        if (next === undefined) {
          unexpected++;
          sendJson(response, 500, { error: 'the script has no more answers' });
          return;
        }
        answer(response, next);
      })
      .catch(() => {
        response.destroy();
      });
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  const baseUrl = `${url}/v1`;
  return {
    baseUrl,
    model: createChatModel({ baseUrl, apiKey: 'test-key', modelId: SCRIPTED_MODEL_ID, temperature: 0, maxTokens: 256, seed: 1 }),
    requests,
    unexpectedRequests: () => unexpected,
  };
}

// The parts of a chat request the tests look at.
const chatRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string().nullable().optional(),
      tool_call_id: z.string().optional(),
      tool_calls: z.array(z.object({ id: z.string() })).optional(),
    }),
  ),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export function chatRequest(model: ScriptedModel, index: number): ChatRequest {
  const body = model.requests[index];
  assert.notEqual(body, undefined, `The model received no request number ${index + 1}`);
  return chatRequestSchema.parse(body);
}

// --- Test double 2: the reply-dropping proxy -------------------------------------------------------
// STAND-IN for a lossy network between the agent and the case system. NOT a case system. It forwards
// every request to the real case system's MCP endpoint and passes the answer back, except for the
// tool calls a test selects: those it forwards, waits until the case system has answered (so the
// write has really been committed), and then never answers the caller.

export type DropRule = (tool: string, nth: number) => boolean;

export type DroppingProxy = {
  mcpUrl: string;
  // How many times each tool was called through the proxy (dropped calls included).
  calls: (tool: string) => number;
  dropped: () => number;
};

const FORWARDED_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'x-message-id', 'x-received-at', 'x-agent-id', 'x-sender'];

function toolCallName(body: unknown): string | undefined {
  if (prop(body, 'method') !== 'tools/call') {
    return undefined;
  }
  const name = prop(prop(body, 'params'), 'name');
  return typeof name === 'string' ? name : undefined;
}

export async function startDroppingProxy(t: TestContext, upstreamMcpUrl: string, drop: DropRule = () => false): Promise<DroppingProxy> {
  const counts = new Map<string, number>();
  let droppedCount = 0;

  async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await bodyText(request);
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') {
        headers[name] = value;
      }
    }
    const tool = toolCallName(parseOrUndefined(body));
    let dropThis = false;
    if (tool !== undefined) {
      const nth = (counts.get(tool) ?? 0) + 1;
      counts.set(tool, nth);
      dropThis = drop(tool, nth);
    }
    const method = request.method ?? 'GET';
    const upstream = await fetch(upstreamMcpUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    const answer = await upstream.text();
    if (dropThis) {
      // The case system has answered; the caller is never told.
      droppedCount++;
      return;
    }
    const out: Record<string, string> = {};
    for (const name of ['content-type', 'mcp-session-id', 'allow']) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        out[name] = value;
      }
    }
    response.writeHead(upstream.status, out);
    response.end(answer);
  }

  const server = createServer((request, response) => {
    forward(request, response).catch(() => {
      response.destroy();
    });
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return { mcpUrl: `${url}/mcp`, calls: (tool) => counts.get(tool) ?? 0, dropped: () => droppedCount };
}

// --- The real case system, in-process --------------------------------------------------------------

export const STORE_START = '2026-03-01T09:00:00.000Z';

export type CaseSystem = { store: CaseStore; mcpUrl: string; reviewUrl: string };

export async function startCaseSystem(t: TestContext): Promise<CaseSystem> {
  const now = steppingClock(STORE_START);
  const store = new CaseStore(':memory:', now);
  const agentServer = createAgentServer(store, now);
  const reviewServer = createReviewServer(store);
  const agentUrl = await listen(agentServer);
  const reviewUrl = await listen(reviewServer);
  t.after(() => {
    stop(agentServer);
    stop(reviewServer);
    store.close();
  });
  return { store, mcpUrl: `${agentUrl}/mcp`, reviewUrl };
}

// --- The agent under test --------------------------------------------------------------------------

export const IDENTITY: AgentIdentity = { id: 'intake-handwritten-test', implementation: 'hand-written loop' };

export const AGENT_START = '2026-03-01T10:00:00.000Z';

export const LIMITS: Limits = { maxTurns: 4, runMs: 5000, modelMs: 500, toolMs: 300 };

export function message(id: string, textBody: string, receivedAt = '2026-03-01T08:55:00.000Z'): InboundMessage {
  return { id, received_at: receivedAt, sender: 'dr.lee@clinic.example', text: textBody };
}

export type RunOptions = {
  model: ChatModel;
  mcpUrl: string;
  clock?: AgentClock;
  limits?: Partial<Limits>;
  // Called after the real connection to the case system has been made.
  afterConnect?: () => void;
};

// Runs the hand-written loop once with the real case-system client, and checks the response keeps
// to the agent contract.
export async function runAgent(options: RunOptions, inbound: InboundMessage): Promise<InvocationResponse> {
  const clock = options.clock ?? agentClock(AGENT_START);
  const deps: IntakeDeps = {
    identity: IDENTITY,
    model: options.model,
    connectTools: async (m, timeoutMs): Promise<Connected> => {
      const connected = await connectCaseTools(options.mcpUrl, m, IDENTITY.id, timeoutMs);
      options.afterConnect?.();
      return connected;
    },
    now: clock.now,
    limits: { ...LIMITS, ...options.limits },
  };
  const response = await handleInquiry(deps, inbound);
  return invocationResponseSchema.parse(response);
}

// --- Reading steps ---------------------------------------------------------------------------------

export type ToolStep = Extract<Step, { kind: 'tool' }>;
export type ModelStep = Extract<Step, { kind: 'model' }>;

export function toolSteps(response: InvocationResponse): ToolStep[] {
  return response.steps.filter((step): step is ToolStep => step.kind === 'tool');
}

export function modelSteps(response: InvocationResponse): ModelStep[] {
  return response.steps.filter((step): step is ModelStep => step.kind === 'model');
}

export function kinds(response: InvocationResponse): string[] {
  return response.steps.map((step) => step.kind);
}

export function onlyItem<T>(items: readonly T[], what: string): T {
  assert.equal(items.length, 1, `Expected exactly one ${what}, found ${items.length}`);
  const [item] = items;
  if (item === undefined) {
    assert.fail(`Expected exactly one ${what}`);
  }
  return item;
}

export function item<T>(items: readonly T[], index: number, what: string): T {
  const found = items[index];
  if (found === undefined) {
    assert.fail(`There is no ${what} number ${index + 1}`);
  }
  return found;
}
