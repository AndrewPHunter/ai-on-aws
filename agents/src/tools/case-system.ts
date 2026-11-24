// What is particular to the case system, whichever implementation is calling it: the context headers
// that say which inbound message a change comes from, the two tools an intake run needs, which both
// change a case, how to read its answers, and what they mean for a run's record. Also the hand-written
// agent's own connection to the case system's MCP tools (connectCaseTools); the Strands agent connects with
// Strands' MCP client and uses everything else here.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { CaseAction, InboundMessage } from '../../../shared/agent-contract.ts';
import type { Telemetry } from '../../../shared/telemetry.ts';
import type { ToolDefinition } from '../model/chat.ts';
import { connectionFailure as readConnectionFailure, payloadOf as readPayload, serviceSentences } from './mcp-answers.ts';
import type { Connected, ToolOutcome } from './tool-set.ts';

// The two tools an intake run needs, and the only ones its model is shown: one opens a case, the other adds
// to a case the message names by its id. Neither returns what a case holds. Both change a case, so a lost
// reply from either leaves the outcome unknown.
export const CASE_TOOLS: readonly string[] = ['create_case', 'add_follow_up'];

// Why a run cannot go on with the tools the case system offered, or undefined when both are there.
export function missingCaseTools(offered: readonly string[]): string | undefined {
  const missing = CASE_TOOLS.filter((name) => !offered.includes(name));
  return missing.length === 0 ? undefined : `The case system does not offer ${missing.join(', ')}.`;
}

// Whether a tool the case system offered is shown to the model. Any other tool it offers is left out, so
// the model can neither see nor call it.
export function isCaseTool(name: string): boolean {
  return CASE_TOOLS.includes(name);
}

// The three headers every request to the case system carries for one run. They say which inbound
// message a change comes from, and who sent the message. Built here, by code, from the message as it
// was received: no implementation lets the model supply or change them. Which agent makes the change
// the case system reads from the token.
export function contextHeaders(message: InboundMessage): Record<string, string> {
  return {
    'x-message-id': message.id,
    'x-received-at': message.received_at,
    // Percent-encoded, because a header cannot carry every character a name can contain.
    'x-sender': encodeURIComponent(message.sender),
  };
}

// Every header a request to the case system carries for one run: the three context headers, and the
// token the agent got for the case system by exchanging the caller's (tool-token.ts).
export function caseSystemHeaders(message: InboundMessage, caseSystemToken: string): Record<string, string> {
  return { ...contextHeaders(message), authorization: `Bearer ${caseSystemToken}` };
}

// Read with the shared reader in mcp-answers.ts, in the case system's name.
const SENTENCES = serviceSentences('case system');

export const CASE_SYSTEM_UNREACHABLE = SENTENCES.unreachable;
export const CASE_SYSTEM_REFUSED_TOKEN = SENTENCES.refusedToken;
export const CASE_SYSTEM_COULD_NOT_CHECK = SENTENCES.couldNotCheck;

// Why connecting to the case system failed, as a run's reason.
export function connectionFailure(error: unknown): string {
  return readConnectionFailure(error, SENTENCES);
}

export function noAnswerWithin(timeoutMs: number): string {
  return `The case system did not answer within ${Math.round(timeoutMs / 100) / 10} s, or the connection failed.`;
}

// What the case system's answer to a tool call carries: one piece of text, which is JSON.
export function payloadOf(result: unknown): unknown {
  return readPayload(result, SENTENCES);
}

// fetch, with the current span of `telemetry` written as traceparent on each request as it is sent. The headers
// given when the connection is made are the same for every request; the trace context is not, so it is written
// here: a tools/call request made inside a tool.call span carries that span (../run/spans.ts).
function fetchCarryingTrace(telemetry: Telemetry): typeof fetch {
  return (input, init) => {
    const carried: Record<string, string> = {};
    telemetry.inject(carried);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(carried)) {
      headers.set(name, value);
    }
    return fetch(input, { ...init, headers });
  };
}

export async function connectCaseTools(
  mcpUrl: string,
  message: InboundMessage,
  agentId: string,
  caseSystemToken: string,
  timeoutMs: number,
  telemetry: Telemetry,
): Promise<Connected> {
  const client = new Client({ name: agentId, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: caseSystemHeaders(message, caseSystemToken) },
    fetch: fetchCarryingTrace(telemetry),
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
