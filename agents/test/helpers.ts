// What the agent's tests share: servers on loopback, clocks the tests control, the real case system
// in-process, and the only two test doubles (each labelled below): a scripted model and a
// reply-dropping proxy in front of the case system's MCP endpoint.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { TestContext } from 'node:test';

import { z } from 'zod';

import { createAccessTokenCheck } from '../../shared/access-token.ts';
import type { AccessTokenCheck, Caller } from '../../shared/access-token.ts';
import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse, Step } from '../../shared/agent-contract.ts';
import { createAgentServer, createReviewServer } from '../../tools/case-system/src/http.ts';
import { startStandInIssuer } from '../../test-support/issuer.ts';
import type { MintOptions, StandInIssuer } from '../../test-support/issuer.ts';
import { CaseStore } from '../../tools/case-system/src/store.ts';
import type { AgentIdentity } from '../src/contract/server.ts';
import { handleInquiry as handleByHand } from '../src/intake/handwritten.ts';
import type { Limits } from '../src/intake/run.ts';
import { handleInquiry as handleWithStrands } from '../src/intake/strands.ts';
import { createChatModel } from '../src/model/chat.ts';
import type { ModelSettings } from '../src/model/served.ts';
import { connectCaseTools } from '../src/tools/case-system.ts';

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
// STAND-IN for the model server. NOT a model. An HTTP server that speaks the routes of the
// OpenAI-compatible API the agents use and answers each request with the next answer from a queue
// the test wrote. It records every request body.
//   GET  /v1/models
//   POST /v1/chat/completions   the hand-written agent. One JSON body.
//   POST /v1/responses          the Strands agent (Strands' default API). A stream of events in the
//                               order and shape the real model server was seen to send them.
// When the queue is empty it answers 500 and counts the request as unexpected, so a test that ran
// past its script fails visibly instead of being handed a default answer.

export type ScriptedAnswer =
  | { kind: 'text'; content: string | null; finishReason: string }
  | { kind: 'tools'; calls: Array<{ name: string; arguments: string; id?: string }>; finishReason: string }
  | { kind: 'status'; status: number }
  | { kind: 'never' };

export type ScriptedModel = {
  baseUrl: string;
  // What an agent needs to call this stand-in.
  settings: ModelSettings;
  // Every body received at /v1/chat/completions or /v1/responses, parsed, in order.
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

  // The same answers as a stream of Responses API events. A turn that ran out of output allowance
  // ends with response.incomplete; any other ends with response.completed.
  function answerAsResponse(response: ServerResponse, next: ScriptedAnswer): void {
    if (next.kind === 'never') {
      return;
    }
    if (next.kind === 'status') {
      sendJson(response, next.status, { error: 'scripted status' });
      return;
    }
    const cutOff = next.finishReason === 'length';
    const about = {
      id: 'resp-scripted',
      object: 'response',
      model: SCRIPTED_MODEL_ID,
      incomplete_details: cutOff ? { reason: 'max_output_tokens' } : null,
    };
    const output: unknown[] = [];
    const events: Array<{ type: string } & Record<string, unknown>> = [
      { type: 'response.created', response: { ...about, status: 'in_progress', incomplete_details: null, output: [] } },
    ];
    if (next.kind === 'text' && next.content !== null && next.content !== '') {
      const id = 'msg-scripted';
      const part = { type: 'output_text', text: next.content, annotations: [] };
      const done = { id, type: 'message', role: 'assistant', status: cutOff ? 'incomplete' : 'completed', content: [part] };
      events.push(
        { type: 'response.output_item.added', output_index: 0, item: { ...done, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
        { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: next.content },
        { type: 'response.output_text.done', item_id: id, output_index: 0, content_index: 0, text: next.content },
        { type: 'response.content_part.done', item_id: id, output_index: 0, content_index: 0, part },
        { type: 'response.output_item.done', output_index: 0, item: done },
      );
      output.push(done);
    }
    if (next.kind === 'tools') {
      next.calls.forEach((c, index) => {
        const callId = c.id ?? `call-${++callIds}`;
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
    events.push({
      type: cutOff ? 'response.incomplete' : 'response.completed',
      response: { ...about, status: cutOff ? 'incomplete' : 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    events.forEach((event, sequenceNumber) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequenceNumber })}\n\n`);
    });
    response.end();
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://model').pathname;
    if (path === '/v1/models' && request.method === 'GET') {
      sendJson(response, 200, { data: [{ id: SCRIPTED_MODEL_ID }] });
      return;
    }
    const responsesApi = path === '/v1/responses';
    if ((path !== '/v1/chat/completions' && !responsesApi) || request.method !== 'POST') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    bodyText(request)
      .then((body) => {
        const parsed = parseOrUndefined(body);
        requests.push(parsed);
        options.onRequest?.(requests.length);
        const next = queue.shift() ?? options.whenEmpty;
        if (next === undefined) {
          unexpected++;
          sendJson(response, 500, { error: 'the script has no more answers' });
          return;
        }
        if (responsesApi) {
          answerAsResponse(response, next);
        } else {
          answer(response, next);
        }
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
    settings: { baseUrl, apiKey: 'test-key', modelId: SCRIPTED_MODEL_ID, temperature: 0, maxTokens: 256, seed: 1 },
    requests,
    unexpectedRequests: () => unexpected,
  };
}

// What a request to the model carried, read the same way from either API, so one assertion covers
// both agents. Nothing is rewritten on the way: a tool result is given exactly as the model was sent it.
export type ModelRequest = {
  system: string | undefined;
  // The text of each user message, in order.
  user: string[];
  // The ids of the tool calls sent back as the assistant's own, in order.
  callIds: string[];
  // What the model was told about each call, in order.
  results: Array<{ callId: string; told: string }>;
  // The names of the tools offered.
  tools: string[];
};

// POST /v1/chat/completions, as the hand-written agent sends it.
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

// POST /v1/responses, as Strands sends it.
const responsesRequestSchema = z.object({
  instructions: z.string().optional(),
  input: z.array(
    z.union([
      z.object({ role: z.literal('user'), content: z.array(z.object({ type: z.literal('input_text'), text: z.string() })) }),
      z.object({ role: z.literal('assistant'), content: z.string() }),
      z.object({ type: z.literal('function_call'), call_id: z.string() }),
      z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() }),
    ]),
  ),
  tools: z.array(z.object({ type: z.literal('function'), name: z.string() })),
});

export function modelRequest(model: ScriptedModel, index: number): ModelRequest {
  const body = model.requests[index];
  assert.notEqual(body, undefined, `The model received no request number ${index + 1}`);
  if (prop(body, 'input') === undefined) {
    const { messages, tools } = chatRequestSchema.parse(body);
    return {
      system: messages.find((m) => m.role === 'system')?.content ?? undefined,
      user: messages.filter((m) => m.role === 'user').map((m) => m.content ?? ''),
      callIds: messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.id),
      results: messages.filter((m) => m.role === 'tool').map((m) => ({ callId: m.tool_call_id ?? '', told: m.content ?? '' })),
      tools: tools.map((tool) => tool.function.name),
    };
  }
  const { instructions, input, tools } = responsesRequestSchema.parse(body);
  const read: ModelRequest = { system: instructions, user: [], callIds: [], results: [], tools: tools.map((tool) => tool.name) };
  for (const entry of input) {
    if ('type' in entry) {
      if (entry.type === 'function_call') {
        read.callIds.push(entry.call_id);
      } else {
        read.results.push({ callId: entry.call_id, told: entry.output });
      }
    } else if (entry.role === 'user') {
      read.user.push(entry.content.map((part) => part.text).join(''));
    }
  }
  return read;
}

// --- Test double 2: the reply-dropping proxy -------------------------------------------------------
// STAND-IN for a lossy network between the agent and the case system. NOT a case system. It forwards
// every request to the real case system's MCP endpoint and passes the answer back, except for the
// tool calls a test selects: those it forwards, waits until the case system has answered (so the
// write has really been committed), and then never answers the caller.

export type DropRule = (tool: string, nth: number) => boolean;

// One request the proxy received, with the headers it arrived with.
export type ProxiedRequest = { method: string | undefined; headers: Record<string, string> };

export type DroppingProxy = {
  mcpUrl: string;
  // Every request, in order, as the agent sent it.
  requests: ProxiedRequest[];
  // How many times each tool was called through the proxy (dropped calls included).
  calls: (tool: string) => number;
  dropped: () => number;
};

const FORWARDED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'x-message-id',
  'x-received-at',
  'x-agent-id',
  'x-sender',
];

function toolCallName(body: unknown): string | undefined {
  if (prop(body, 'method') !== 'tools/call') {
    return undefined;
  }
  const name = prop(prop(body, 'params'), 'name');
  return typeof name === 'string' ? name : undefined;
}

export type ProxyOptions = {
  // Called with the MCP method of each request as it arrives (initialize, tools/list, tools/call).
  onMethod?: (method: string) => void;
};

export async function startDroppingProxy(
  t: TestContext,
  upstreamMcpUrl: string,
  drop: DropRule = () => false,
  options: ProxyOptions = {},
): Promise<DroppingProxy> {
  const counts = new Map<string, number>();
  const requests: ProxiedRequest[] = [];
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
    const parsedBody = parseOrUndefined(body);
    const method = prop(parsedBody, 'method');
    requests.push({ method: typeof method === 'string' ? method : undefined, headers: { ...headers } });
    if (typeof method === 'string') {
      options.onMethod?.(method);
    }
    const tool = toolCallName(parsedBody);
    let dropThis = false;
    if (tool !== undefined) {
      const nth = (counts.get(tool) ?? 0) + 1;
      counts.set(tool, nth);
      dropThis = drop(tool, nth);
    }
    const verb = request.method ?? 'GET';
    const upstream = await fetch(upstreamMcpUrl, {
      method: verb,
      headers,
      body: verb === 'GET' || verb === 'HEAD' ? undefined : body,
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
  return { mcpUrl: `${url}/mcp`, requests, calls: (tool) => counts.get(tool) ?? 0, dropped: () => droppedCount };
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

// --- The agents under test -------------------------------------------------------------------------

export const AGENT_START = '2026-03-01T10:00:00.000Z';

export const LIMITS: Limits = { maxTurns: 4, runMs: 5000, modelMs: 500, toolMs: 300 };

export function message(id: string, textBody: string, receivedAt = '2026-03-01T08:55:00.000Z'): InboundMessage {
  return { id, received_at: receivedAt, sender: 'dr.lee@clinic.example', text: textBody };
}

// The caller a run is for, as the agent's server hands it to the handler once the token was accepted.
// The handlers do not check the token; the server does, and that is tested in auth.test.ts.
export const TEST_CALLER: Caller = {
  subject: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02',
  username: 'dana.desk',
  name: 'Dana Desk',
  clientId: 'desk',
  roles: ['default-roles-lab'],
  expiresAt: new Date('2026-03-01T10:10:00.000Z'),
  token: 'access-token-of-the-test-caller',
};

export type RunOptions = {
  model: ModelSettings;
  mcpUrl: string;
  // Who the run is for. Default: TEST_CALLER.
  caller?: Caller;
  clock?: AgentClock;
  limits?: Partial<Limits>;
  // The hand-written loop only: each wait between two requests to the model is added here, and the
  // agent's clock is moved on by it. No test waits in real time. Strands and the OpenAI client wait
  // for themselves, in real time.
  waits?: number[];
  // The hand-written loop only: what its source of randomness gives. 1 unless said, the longest wait.
  random?: number;
};

// One implementation of the intake agent, as the behaviour table drives it. `run` handles one
// message with the real case-system connection and checks the response keeps to the agent contract.
// The other fields are the differences between the implementations that the table names outright;
// every other row of the table holds for both.
export type Implementation = {
  name: string;
  identity: AgentIdentity;
  run(options: RunOptions, inbound: InboundMessage): Promise<InvocationResponse>;
  // What this implementation records as the way a model turn ended. The hand-written loop records
  // the server's own words; Strands replaces them with its own before any hook sees them.
  finish: { stop: string; length: string };
  // Tool arguments that are not JSON. The hand-written loop tells the model and carries on.
  // Strands stops the run with an error. Nothing is called in either.
  argumentsNotJson: 'told_to_model' | 'run_fails';
  // Whether a turn that is asked again (lost to thinking) uses up one of the run's turns.
  // Strands does not count a model call it retries.
  retriedTurnCounts: boolean;
  // What stands in front of a tool result that is an error when the model is told it. The
  // hand-written loop sends the result as it is. Strands marks it.
  errorResultPrefix: '' | '[ERROR] ';
  // How a request says the model should not think first. The hand-written loop speaks chat
  // completions, where the model server takes it as a setting for the model's chat template.
  // Strands speaks the Responses API, which has a setting of its own.
  thinkingOff: { key: string; value: unknown };
  // A reply cut off part way by the output allowance. The hand-written loop returns what was
  // written. Strands treats the turn as an error, so no reply is returned; what was written is kept
  // in the step.
  cutOffReply: 'returned' | 'not_returned';
  // Whether a failed request to the model that is sent again leaves an error step. The hand-written
  // loop sends it again itself and records each failure. For Strands the OpenAI client sends it
  // again inside itself, and no hook hears of it.
  retriedRequestRecorded: boolean;
  // How many requests a model that never answers is sent, when the run has time for two and a half.
  // The hand-written loop does not send a timed-out request again. The OpenAI client inside Strands
  // does, and the run's time limit cuts the second one short.
  requestsToSilentModel: 1 | 2;
  // Three requests in a row answered 429. The hand-written loop has asked its three times and fails
  // the run. For Strands that was only the OpenAI client's three: Strands' own retry then waits and
  // has the client ask again.
  afterThreeThrottled: 'run_fails' | 'asks_again';
};

export const HANDWRITTEN: Implementation = {
  name: 'hand-written',
  identity: { id: 'intake-handwritten-test', implementation: 'hand-written loop' },
  finish: { stop: 'stop', length: 'length' },
  argumentsNotJson: 'told_to_model',
  retriedTurnCounts: true,
  errorResultPrefix: '',
  thinkingOff: { key: 'chat_template_kwargs', value: { enable_thinking: false } },
  cutOffReply: 'returned',
  retriedRequestRecorded: true,
  requestsToSilentModel: 1,
  afterThreeThrottled: 'run_fails',
  async run(options, inbound) {
    const clock = options.clock ?? agentClock(AGENT_START);
    const response = await handleByHand(
      {
        identity: this.identity,
        model: createChatModel(options.model),
        connectTools: (m, token, timeoutMs) => connectCaseTools(options.mcpUrl, m, this.identity.id, token, timeoutMs),
        now: clock.now,
        sleep: (ms) => {
          clock.advance(ms);
          options.waits?.push(ms);
          return Promise.resolve();
        },
        random: () => options.random ?? 1,
        limits: { ...LIMITS, ...options.limits },
      },
      inbound,
      options.caller ?? TEST_CALLER,
    );
    return invocationResponseSchema.parse(response);
  },
};

const STRANDS: Implementation = {
  name: 'strands',
  identity: { id: 'intake-strands-test', implementation: 'Strands' },
  finish: { stop: 'endTurn', length: 'maxTokens' },
  argumentsNotJson: 'run_fails',
  retriedTurnCounts: false,
  errorResultPrefix: '[ERROR] ',
  thinkingOff: { key: 'reasoning', value: { effort: 'none' } },
  cutOffReply: 'not_returned',
  retriedRequestRecorded: false,
  requestsToSilentModel: 2,
  afterThreeThrottled: 'asks_again',
  async run(options, inbound) {
    const clock = options.clock ?? agentClock(AGENT_START);
    const response = await handleWithStrands(
      {
        identity: this.identity,
        model: options.model,
        caseMcpUrl: options.mcpUrl,
        now: clock.now,
        limits: { ...LIMITS, ...options.limits },
      },
      inbound,
      options.caller ?? TEST_CALLER,
    );
    return invocationResponseSchema.parse(response);
  },
};

export const IMPLEMENTATIONS: readonly Implementation[] = [HANDWRITTEN, STRANDS];

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

// --- Access tokens ---------------------------------------------------------------------------------
// Real signed tokens from the stand-in issuer in test-support/, checked by the real shared check.

export const TOKEN_ISSUER = 'http://localhost:8090/realms/lab';
export const TOKEN_MIN_REMAINING_SECONDS = 150;

export const TOKEN_CLAIMS = {
  aud: ['lab-agents', 'lab-case-system'],
  client_id: 'desk',
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f01',
  preferred_username: 'riley.reviewer',
  name: 'Riley Reviewer',
  roles: ['default-roles-lab', 'reviewer'],
};

export type TokenRig = {
  issuer: StandInIssuer;
  check: AccessTokenCheck;
  // A token with the claims above, 600 s to live, overridden as asked.
  mint: (options?: Partial<MintOptions>) => Promise<string>;
};

export async function startTokenRig(t: TestContext): Promise<TokenRig> {
  const clock = agentClock(AGENT_START);
  const issuer = await startStandInIssuer({
    clientId: 'desk',
    clientSecret: 'stand-in-secret',
    redirectUri: 'http://localhost:3000/auth/callback',
    postLogoutRedirectUri: 'http://localhost:3000/',
    now: clock.now,
    issuer: TOKEN_ISSUER,
  });
  t.after(() => issuer.close());
  const check = createAccessTokenCheck(
    {
      discoveryUrl: issuer.discoveryUrl,
      issuer: TOKEN_ISSUER,
      audience: 'lab-agents',
      allowedClients: ['desk'],
      rolesClaim: 'roles',
      minRemainingSeconds: TOKEN_MIN_REMAINING_SECONDS,
    },
    { now: clock.now, keyRefetchWaitMs: 30_000, timeoutMs: 2000 },
  );
  const mint = (options: Partial<MintOptions> = {}): Promise<string> =>
    issuer.mintAccessToken({ lifetimeSeconds: 600, ...options, claims: { ...TOKEN_CLAIMS, ...options.claims } });
  return { issuer, check, mint };
}
