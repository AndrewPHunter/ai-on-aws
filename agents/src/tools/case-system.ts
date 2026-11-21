// What is particular to the case system: how to connect to its three MCP tools with the context
// headers that say which inbound message and which agent a change comes from, which of its tools
// change a case, and what its answers mean for a run's record. The model never sees or sets those
// headers; they are fixed here, by code, for the whole of one run.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { CaseAction, InboundMessage } from '../../../shared/agent-contract.ts';
import type { ToolDefinition } from '../model/chat.ts';
import type { Connected, ToolOutcome } from './tool-set.ts';

// The tools that change a case. A lost reply from one of these leaves the outcome unknown.
export const WRITING_TOOLS: readonly string[] = ['create_case', 'add_follow_up'];

function payloadOf(result: unknown): unknown {
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
  timeoutMs: number,
): Promise<Connected> {
  const client = new Client({ name: agentId, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        'x-message-id': message.id,
        'x-received-at': message.received_at,
        'x-agent-id': agentId,
        // Percent-encoded, because a header cannot carry every character a name can contain.
        'x-sender': encodeURIComponent(message.sender),
      },
    },
  });

  let definitions: ToolDefinition[];
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    definitions = listed.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema },
    }));
  } catch {
    await client.close().catch(() => undefined);
    return { ok: false, reason: 'The case system could not be reached.' };
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
          return {
            kind: 'no_answer',
            reason: `The case system did not answer within ${Math.round(callTimeoutMs / 100) / 10} s, or the connection failed.`,
          };
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
