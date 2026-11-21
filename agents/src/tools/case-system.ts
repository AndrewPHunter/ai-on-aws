// What is particular to the case system, whichever implementation is calling it: the context headers
// that say which inbound message and which agent a change comes from, which of its tools change a
// case, how to read its answers, and what they mean for a run's record. Also the hand-written
// agent's own connection to its three MCP tools (connectCaseTools); the Strands agent connects with
// Strands' MCP client and uses everything else here.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { CaseAction, InboundMessage } from '../../../shared/agent-contract.ts';
import type { ToolDefinition } from '../model/chat.ts';
import type { Connected, ToolOutcome } from './tool-set.ts';

// The tools that change a case. A lost reply from one of these leaves the outcome unknown.
export const WRITING_TOOLS: readonly string[] = ['create_case', 'add_follow_up'];

// The four headers every request to the case system carries for one run. They say which inbound
// message and which agent a change comes from, and who sent the message. Built here, by code, from
// the message as it was received: no implementation lets the model supply or change them.
export function contextHeaders(message: InboundMessage, agentId: string): Record<string, string> {
  return {
    'x-message-id': message.id,
    'x-received-at': message.received_at,
    'x-agent-id': agentId,
    // Percent-encoded, because a header cannot carry every character a name can contain.
    'x-sender': encodeURIComponent(message.sender),
  };
}

// Every header a request to the case system carries for one run: the four context headers, and the
// access token of the caller the run is for, passed on as it was presented.
export function caseSystemHeaders(message: InboundMessage, agentId: string, callerToken: string): Record<string, string> {
  return { ...contextHeaders(message, agentId), authorization: `Bearer ${callerToken}` };
}

export const CASE_SYSTEM_UNREACHABLE = 'The case system could not be reached.';
export const CASE_SYSTEM_REFUSED_TOKEN = "The case system refused the caller's token.";
export const CASE_SYSTEM_COULD_NOT_CHECK = "The case system could not check the caller's token.";

// Every error in a chain: each one, its cause, and the errors an aggregate holds.
function errorsIn(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);
  const found: unknown[] = [error];
  if (error instanceof Error) {
    found.push(...errorsIn(error.cause, seen));
  }
  if (error instanceof AggregateError) {
    for (const inner of error.errors) found.push(...errorsIn(inner, seen));
  }
  return found;
}

// The text an error carries about the answer it came from: its message, and the answer's body where the
// MCP client keeps it apart (@modelcontextprotocol/client puts it in data.text).
function textsOf(error: unknown): string[] {
  const texts = [error instanceof Error ? error.message : String(error)];
  const data: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'data') : undefined;
  const body: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'text') : undefined;
  if (typeof body === 'string') texts.push(body);
  return texts;
}

// Why connecting to the case system failed, as a run's reason. The case system answers a refused token
// with 401 and {"error":"unauthorized"}, and a token it cannot check with 503 and
// {"error":"identity_unavailable"}. The hand-written agent's MCP client puts that body in its error's
// message; the one inside Strands keeps it in the error's data. Anything else is a case system not reached.
export function connectionFailure(error: unknown): string {
  const messages = errorsIn(error).flatMap(textsOf);
  if (messages.some((message) => message.includes('"error":"unauthorized"'))) {
    return CASE_SYSTEM_REFUSED_TOKEN;
  }
  if (messages.some((message) => message.includes('"error":"identity_unavailable"'))) {
    return CASE_SYSTEM_COULD_NOT_CHECK;
  }
  return CASE_SYSTEM_UNREACHABLE;
}

export function noAnswerWithin(timeoutMs: number): string {
  return `The case system did not answer within ${Math.round(timeoutMs / 100) / 10} s, or the connection failed.`;
}

// What the case system's answer to a tool call carries: one piece of text, which is JSON.
export function payloadOf(result: unknown): unknown {
  const content: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'content') : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined;
  if (typeof text !== 'string') {
    return { error: 'unreadable_result', detail: 'The case system answered with something that is not text.' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

export async function connectCaseTools(
  mcpUrl: string,
  message: InboundMessage,
  agentId: string,
  callerToken: string,
  timeoutMs: number,
): Promise<Connected> {
  const client = new Client({ name: agentId, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: caseSystemHeaders(message, agentId, callerToken) },
  });

  let definitions: ToolDefinition[];
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    definitions = listed.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema },
    }));
  } catch (error) {
    await client.close().catch(() => undefined);
    return { ok: false, reason: connectionFailure(error) };
  }

  return {
    ok: true,
    tools: {
      definitions,
      async call(name, args, callTimeoutMs) {
        try {
          const result = await client.callTool({ name, arguments: args }, undefined, { timeout: callTimeoutMs });
          return { kind: 'answered', isError: result.isError === true, payload: payloadOf(result) };
        } catch {
          return { kind: 'no_answer', reason: noAnswerWithin(callTimeoutMs) };
        }
      },
      async close() {
        await client.close().catch(() => undefined);
      },
    },
  };
}

const writeResultSchema = z.object({
  outcome: z.string(),
  case: z.object({ case_id: z.string(), status: z.string() }),
});

const conflictSchema = z.object({
  error: z.literal('case_already_opened_for_this_message'),
  case: z.object({ case_id: z.string(), status: z.string() }),
});

// What a tool result means for the run's record of what happened to cases. Derived from what the
// case system said, never from what the model says it did.
export function caseActionFrom(tool: string, outcome: ToolOutcome): CaseAction | undefined {
  if (outcome.kind !== 'answered') {
    return undefined;
  }
  if (outcome.isError) {
    // A refused create_case that names the case already opened for this message still tells the run
    // which case that is. This is what a re-sent message looks like when the model words it differently.
    const refusal = conflictSchema.safeParse(outcome.payload);
    return tool === 'create_case' && refusal.success
      ? { kind: 'case_already_open', case_id: refusal.data.case.case_id, status: refusal.data.case.status }
      : undefined;
  }
  const parsed = writeResultSchema.safeParse(outcome.payload);
  if (!parsed.success) {
    return undefined;
  }
  const { case_id, status } = parsed.data.case;
  if (tool === 'create_case' && parsed.data.outcome === 'created') {
    return { kind: 'case_opened', case_id, status };
  }
  if (tool === 'create_case' && parsed.data.outcome === 'replayed') {
    return { kind: 'case_already_open', case_id, status };
  }
  if (tool === 'add_follow_up' && (parsed.data.outcome === 'recorded' || parsed.data.outcome === 'replayed')) {
    return { kind: 'follow_up_recorded', case_id, status };
  }
  return undefined;
}
